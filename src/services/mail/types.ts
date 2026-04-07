// src/services/mail/types.ts
// Provider abstraction — multi-provider mail support (Gmail, Outlook, ...)

export interface RawMessage {
  id: string;
  threadId: string;
  internalDate: Date;
}

export interface FullMessage {
  id: string;
  threadId: string;
  from: string;       // "Name <email@host>"
  fromEmail: string;  // "email@host" (lowercase)
  to: string;
  subject: string;
  date: Date;
  body: string;
  attachments: AttachmentMeta[];
  isSent: boolean;
}

export interface AttachmentMeta {
  id: string;       // provider-specific attachment ID
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailProvider {
  readonly name: 'gmail' | 'outlook';

  /**
   * Yields raw message descriptors (id + date) since the given date.
   * Implementations must respect max and stop early if exceeded.
   */
  listMessagesSince(after: Date, max: number): AsyncGenerator<RawMessage>;

  /**
   * Yields raw message descriptors for SENT messages since the given date.
   */
  listSentMessages(after: Date, max: number): AsyncGenerator<RawMessage>;

  /**
   * Fetches the full message content by ID.
   * Throws TokenInvalidError if the access/refresh token is expired or revoked.
   */
  getFullMessage(id: string): Promise<FullMessage>;

  /**
   * Downloads the raw binary for a single attachment.
   * Throws TokenInvalidError if the token is expired.
   */
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

export class TokenInvalidError extends Error {
  constructor(
    public readonly provider: 'gmail' | 'outlook',
    public readonly userId: string
  ) {
    super(`Token ${provider} invalide pour user ${userId}`);
    this.name = 'TokenInvalidError';
    Object.setPrototypeOf(this, TokenInvalidError.prototype);
  }
}
