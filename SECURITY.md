# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in mcp-obsidian, **do not open a public issue.**

Instead, please use [GitHub's private vulnerability reporting](https://github.com/Wicked-Evolutions/Mycelium-for-Obsidian/security/advisories/new) to report it directly.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

We will acknowledge receipt within 48 hours and provide a timeline for a fix. Critical vulnerabilities will be patched and released as soon as possible.

## Scope

This policy covers:
- The mcp-obsidian MCP server (this repository)
- Vault path resolution and file access
- Environment variable handling (vault paths, disabled tools)
- Section editing and content manipulation
- Semantic search indexing and queries
- CLI bridge command execution
- HTTP server mode

## Supported Versions

We support the latest released version. Older versions do not receive security patches — please update.
