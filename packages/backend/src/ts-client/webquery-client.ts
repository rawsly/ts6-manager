import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { TSApiError } from '../middleware/error-handler.js';
import { config } from '../config.js';

export class WebQueryClient {
  private http: AxiosInstance;
  private agent: http.Agent | https.Agent;

  constructor(
    private host: string,
    private port: number,
    private apiKey: string,
    private useHttps: boolean = false,
  ) {
    const { agent, http } = this.buildTransport();
    this.agent = agent;
    this.http = http;
  }

  private buildTransport(): { agent: http.Agent | https.Agent; http: AxiosInstance } {
    const protocol = this.useHttps ? 'https' : 'http';

    // Use a single persistent TCP connection (keep-alive) to the TS WebQuery API.
    // Without this, each concurrent request opens a new TCP connection, and the
    // TS server registers each one as a separate "serveradmin" query client
    // (serveradmin, serveradmin1, serveradmin2, ...).
    const agent = this.useHttps
      ? new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 10_000,
          maxSockets: 1,
          rejectUnauthorized: !config.tsAllowSelfSigned,
        })
      : new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 1 });

    const httpClient = axios.create({
      baseURL: `${protocol}://${this.host}:${this.port}`,
      headers: { 'x-api-key': this.apiKey },
      timeout: 15_000,
      httpAgent: this.useHttps ? undefined : agent,
      httpsAgent: this.useHttps ? agent : undefined,
    });

    return { agent, http: httpClient };
  }

  private isRetryableTransportError(error: any): boolean {
    const code = error?.code || error?.cause?.code;
    const message = String(error?.message || '').toLowerCase();

    // Axios/Node sometimes reports connection resets as a plain message.
    const looksLikeHangUp = message.includes('socket hang up') || message.includes('socket hangup');

    return code === 'ECONNRESET' || code === 'EPIPE' || looksLikeHangUp;
  }

  private toConnectionResetDetails(error: any): string {
    const protocol = this.useHttps ? 'https' : 'http';
    const code = error?.code || error?.cause?.code;
    const message = String(error?.message || '').trim();

    const suffix = code || message ? ` (code=${code ?? 'n/a'}, message=${message || 'n/a'})` : '';
    return (
      `Connection dropped by TeamSpeak WebQuery (${protocol}://${this.host}:${this.port})${suffix}. ` +
      `Common causes: TS6 query IP allow/deny list blocks this client IP (or it was denylisted), ` +
      `or the HTTP/HTTPS setting doesn't match the port.`
    );
  }

  private async requestWithRetry<T>(fn: (client: AxiosInstance) => Promise<T>): Promise<T> {
    try {
      return await fn(this.http);
    } catch (error: any) {
      if (!this.isRetryableTransportError(error)) throw error;

      // The TS WebQuery server can close an idle keep-alive socket.
      // Retry once with a fresh agent/socket and, if successful, swap transports.
      const fresh = this.buildTransport();
      try {
        const result = await fn(fresh.http);
        this.agent.destroy();
        this.agent = fresh.agent;
        this.http = fresh.http;
        return result;
      } catch (retryError) {
        fresh.agent.destroy();
        throw retryError;
      }
    }
  }

  async execute(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    try {
      // WebQuery URL pattern: /{sid}/{command}
      // For instance-level commands (sid=0): /{command}
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;

      const response = await this.requestWithRetry((client) =>
        client.get(path, {
          params: this.cleanParams(params),
        }),
      );

      const data = response.data;

      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      if (error instanceof TSApiError) throw error;
      if (error.response?.data?.status) {
        throw new TSApiError(
          error.response.data.status.code,
          error.response.data.status.message,
        );
      }

      if (this.isRetryableTransportError(error)) {
        throw new TSApiError(-1, this.toConnectionResetDetails(error));
      }

      throw new TSApiError(-1, error.message || 'Connection failed');
    }
  }

  async executePost(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    try {
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
      const response = await this.requestWithRetry((client) =>
        client.post(path, null, {
          params: this.cleanParams(params),
        }),
      );

      const data = response.data;
      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      if (error instanceof TSApiError) throw error;
      if (error.response?.data?.status) {
        throw new TSApiError(
          error.response.data.status.code,
          error.response.data.status.message,
        );
      }

      if (this.isRetryableTransportError(error)) {
        throw new TSApiError(-1, this.toConnectionResetDetails(error));
      }

      throw new TSApiError(-1, error.message || 'Connection failed');
    }
  }

  // Remove undefined/null values from params
  private cleanParams(params?: Record<string, any>): Record<string, any> | undefined {
    if (!params) return undefined;
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  // Test connection
  async testConnection(): Promise<boolean> {
    try {
      await this.execute(0, 'version');
      return true;
    } catch {
      return false;
    }
  }

  // Destroy the HTTP agent, closing all keep-alive sockets.
  // Call this for temporary clients (e.g. test connection) to avoid lingering query logins.
  destroy(): void {
    this.agent.destroy();
  }
}
