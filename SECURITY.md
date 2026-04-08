# Security Policy

## Overview

The HexmonSignage Player is designed with security as a top priority. This document outlines the security features, best practices, and vulnerability reporting procedures.

## Security Features

### 1. Mutual TLS (mTLS) Authentication

**Implementation:**
- ECDSA P-256 key pair generation
- Certificate Signing Request (CSR) generation with device information
- Client certificate authentication for all API communication
- Certificate auto-renewal before expiration

**Key Files:**
- `/var/lib/hexmon/certs/client.key` - Private key (0600 permissions)
- `/var/lib/hexmon/certs/client.crt` - Client certificate (0600 permissions)
- `/var/lib/hexmon/certs/ca.crt` - CA certificate (0600 permissions)

**Best Practices:**
- Never share private keys
- Rotate certificates before expiration
- Use strong CA certificates
- Monitor certificate expiry dates

### 2. Content Security Policy (CSP)

**Renderer Process CSP:**
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
media-src 'self' https:;
connect-src 'self' https: wss:;
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'none';
frame-ancestors 'none';
```

**Purpose:**
- Prevent XSS attacks
- Restrict resource loading
- Prevent clickjacking
- Limit inline scripts

### 3. Renderer Process Sandboxing

**Configuration:**
- `sandbox: true` - Enable OS-level sandboxing
- `nodeIntegration: false` - Disable Node.js in renderer
- `contextIsolation: true` - Isolate preload context
- `webSecurity: true` - Enable web security features

**Benefits:**
- Isolate renderer from main process
- Prevent unauthorized system access
- Limit attack surface
- Protect against malicious content

### 4. Secure File Permissions

**Certificate Directory:**
```bash
/var/lib/hexmon/certs/     # 0700 (drwx------)
  client.key               # 0600 (-rw-------)
  client.crt               # 0600 (-rw-------)
  ca.crt                   # 0600 (-rw-------)
```

**Configuration:**
```bash
/etc/hexmon/               # 0750 (drwxr-x---)
  config.json              # 0640 (-rw-r-----)
```

**Cache:**
```bash
/var/cache/hexmon/         # 0755 (drwxr-xr-x)
  objects/                 # 0755 (drwxr-xr-x)
  logs/                    # 0755 (drwxr-xr-x)
```

### 5. PII Redaction in Logs

**Automatically Redacted:**
- Email addresses
- Social Security Numbers (SSN)
- Credit card numbers
- Phone numbers
- API keys and tokens

**Implementation:**
```typescript
// Emails: user@example.com → [EMAIL_REDACTED]
// SSN: 123-45-6789 → [SSN_REDACTED]
// Credit Cards: 4111-1111-1111-1111 → [CC_REDACTED]
```

### 6. Input Sanitization

**Path Sanitization:**
- Remove directory traversal attempts (`../`)
- Strip null bytes
- Validate file extensions
- Limit path length

**URL Validation:**
- Validate URL format
- Check domain allowlist (for URL media type)
- Prevent file:// protocol
- Sanitize query parameters

### 7. Atomic File Operations

**Implementation:**

### 8. Local Metrics Surface

The player exposes `/healthz` and optional `/metrics` from the local health server.

Secure defaults:
- bind to `127.0.0.1`
- keep `observability.allowRemoteAccess=false`
- allow `/healthz` without forcing Prometheus exposition
- avoid permissive cross-origin access on the metrics listener

If direct Prometheus scraping is approved for a site, move the bind address and firewall rules together. Do not expose the player metrics port broadly by default.
- Write to temporary file first
- Verify write success
- Atomic rename to final destination
- Prevents partial writes and corruption

### 8. SHA-256 Integrity Verification

**Cache Integrity:**
- Calculate SHA-256 hash of downloaded files
- Compare with expected hash
- Quarantine files with mismatched hashes
- Prevent corrupted or tampered content

## Security Best Practices

### For Administrators

1. **Certificate Management:**
   - Rotate certificates every 90 days
   - Monitor certificate expiry
   - Use strong CA certificates
   - Never share private keys

2. **Access Control:**
   - Run service as dedicated `hexmon` user
   - Limit sudo access
   - Use firewall rules to restrict network access
   - Monitor system logs

3. **Network Security:**
   - Use HTTPS for all API communication
   - Enable mTLS in production
   - Use VPN or private network when possible
   - Monitor network traffic

4. **System Hardening:**
   - Keep system updated
   - Disable unnecessary services
   - Use SELinux or AppArmor
   - Enable automatic security updates

5. **Monitoring:**
   - Monitor health endpoint regularly
   - Set up alerts for errors
   - Review logs periodically
   - Track certificate expiry

### For Developers

1. **Code Security:**
   - Use TypeScript strict mode
   - Validate all inputs
   - Sanitize file paths
   - Use parameterized queries

2. **Dependency Management:**
   - Keep dependencies updated
   - Audit dependencies regularly
   - Use lock files
   - Review security advisories

3. **Secrets Management:**
   - Never commit secrets to git
   - Use environment variables
   - Encrypt sensitive configuration
   - Rotate secrets regularly

4. **Error Handling:**
   - Never expose stack traces to users
   - Log errors securely
   - Redact sensitive information
   - Handle errors gracefully

## Vulnerability Reporting

### Reporting a Vulnerability

If you discover a security vulnerability, please report it to:

**Email:** security@hexmon.com

**Please include:**
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

**Response Time:**
- Initial response: Within 24 hours
- Status update: Within 7 days
- Fix timeline: Depends on severity

### Severity Levels

**Critical:**
- Remote code execution
- Authentication bypass
- Data breach

**High:**
- Privilege escalation
- SQL injection
- XSS vulnerabilities

**Medium:**
- Information disclosure
- CSRF vulnerabilities
- Weak cryptography

**Low:**
- Minor information leaks
- Configuration issues
- Non-security bugs

## Security Updates

### Update Policy

- **Critical vulnerabilities:** Patched within 24-48 hours
- **High vulnerabilities:** Patched within 7 days
- **Medium vulnerabilities:** Patched within 30 days
- **Low vulnerabilities:** Patched in next release

### Update Notifications

Security updates are announced via:
- Email to registered administrators
- Security advisory on website
- GitHub security advisories
- Release notes

## Compliance

### Standards

The HexmonSignage Player follows these security standards:
- OWASP Top 10
- CWE/SANS Top 25
- NIST Cybersecurity Framework
- ISO 27001 principles

### Auditing

- Regular security audits
- Penetration testing
- Code reviews
- Dependency scanning

## Security Checklist

### Deployment Checklist

- [ ] mTLS enabled and configured
- [ ] Certificates have correct permissions (0600)
- [ ] Service runs as dedicated user
- [ ] Firewall rules configured
- [ ] HTTPS enforced for all communication
- [ ] Logs are monitored
- [ ] Health endpoint is accessible
- [ ] Automatic updates enabled
- [ ] Backup and recovery plan in place
- [ ] Incident response plan documented

### Maintenance Checklist

- [ ] Review logs weekly
- [ ] Check certificate expiry monthly
- [ ] Update dependencies monthly
- [ ] Review access logs monthly
- [ ] Test backup recovery quarterly
- [ ] Conduct security audit annually
- [ ] Review and update security policies annually

## Additional Resources

- [OWASP Electron Security](https://owasp.org/www-community/vulnerabilities/Electron_Security)
- [Electron Security Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

## Contact

For security-related questions or concerns:
- Email: security@hexmon.com
- Documentation: https://docs.hexmon.com/security
- Support: support@hexmon.com

---

**Last Updated:** 2025-01-05
**Version:** 1.0.0
