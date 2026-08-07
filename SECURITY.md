# Security Policy

## Reporting

Please report suspected vulnerabilities privately through GitHub Security Advisories for this repository. Do not include active credentials, session files, chat identifiers, or message contents in a public issue.

## Sensitive data

The extension stores credentials and Pi conversation logs under `~/.pi/agent/state/pi-feishu-bot/`. Keep the directory private, never commit it, and rotate the Feishu App Secret immediately if it is exposed.

Pi extensions execute with the installing user's system permissions. Review package source and pinned releases before installation.
