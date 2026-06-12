from __future__ import annotations

import smtplib
from email.message import EmailMessage

from .config import SMTPSettings


class Notifier:
    def __init__(self, settings: SMTPSettings):
        self.settings = settings

    def send(self, subject: str, body: str) -> bool:
        if not self.settings.enabled:
            print(f"[alert disabled] {subject}\n{body}")
            return False

        if not self.settings.to_addrs:
            print("[alert skipped] notifier.smtp.to_addrs is empty")
            return False

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.settings.from_addr
        msg["To"] = ", ".join(self.settings.to_addrs)
        msg.set_content(body)

        if self.settings.use_ssl:
            with smtplib.SMTP_SSL(self.settings.host, self.settings.port, timeout=20) as smtp:
                self._login(smtp)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(self.settings.host, self.settings.port, timeout=20) as smtp:
                smtp.starttls()
                self._login(smtp)
                smtp.send_message(msg)
        return True

    def _login(self, smtp: smtplib.SMTP) -> None:
        if self.settings.username:
            smtp.login(self.settings.username, self.settings.password)
