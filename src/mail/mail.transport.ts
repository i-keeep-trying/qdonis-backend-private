export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Delivery mechanism behind {@link MailService}. */
export abstract class MailTransport {
  abstract send(message: MailMessage): Promise<void>;
  /** Checks connectivity/credentials. Resolves on success, rejects otherwise. */
  abstract verify(): Promise<void>;
  /** Releases pooled connections on shutdown. */
  abstract close(): void;
}
