import { Injectable } from "@nestjs/common";
import { withSpan } from "@nestrix-js/nestjs";

// Whatever sends your mail: nodemailer, a vendor SDK over SMTP, a queue.
interface MailTransport {
  readonly name: string;
  send(message: { to: string; subject: string; html: string }): Promise<void>;
}

@Injectable()
export class MailService {
  constructor(private readonly transport: MailTransport) {}

  async sendWelcome(to: string): Promise<void> {
    return withSpan("mail.send", async (span) => {
      // Only the transport and the outcome. No address, subject or content.
      span.setAttribute("mail.transport", this.transport.name);
      try {
        await this.transport.send({
          to,
          subject: "Welcome",
          html: "<p>Hi</p>",
        });
        span.setAttribute("mail.outcome", "sent");
      } catch (error) {
        span.setAttribute("mail.outcome", "failed");
        throw error; // withSpan records it and sets the error status
      }
    });
  }
}
