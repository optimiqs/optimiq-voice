# Alpine 3.24 ships Asterisk 22.9.0 (22.x LTS, supported until 2028) in main.
# Asterisk 20 goes security-fix-only on 2026-10-19, hence the bump.
# NOTE: no Alpine release before 3.24 carries Asterisk 22 (3.21/3.22 -> 20.11,
# 3.23 -> 20.15); only bump the base image to a branch that still has 22.x.
FROM alpine:3.24
LABEL team="Optimiq Voice Team <team@optimiq.health>"

COPY config /etc/asterisk/
COPY run.sh /
# Since Alpine 3.22 the Asterisk data dir (sounds, rest-api, ...) is installed
# under /usr/share/asterisk instead of /var/lib/asterisk. config/asterisk.conf
# pins astdatadir to match.
COPY sounds/ /usr/share/asterisk/sounds/en

# `asterisk-srtp` carries res_srtp.so, which is what makes `media_encryption = sdes` in
# pjsip_tls.conf actually emit an `a=crypto` line. Without it the setting parses, the call sets up,
# and the media is plaintext — the failure that looks like success. modules.conf lists the module
# explicitly so a build that lost this package fails at startup rather than at call time.
RUN apk add --no-cache --update asterisk asterisk-curl asterisk-srtp tini \
 && chmod +x /run.sh \
 && chown -R asterisk:asterisk /etc/asterisk \
 && chown -R asterisk:asterisk /usr/share/asterisk/sounds \
 # logger.conf writes the Security Events feed to /var/log/asterisk/security. The process runs as
 # `asterisk`, so the directory has to be writable by it or the channel is silently not opened.
 && mkdir -p /var/log/asterisk \
 && chown -R asterisk:asterisk /var/log/asterisk \
 && chown asterisk:asterisk /run.sh

USER asterisk:asterisk

# Re-mapping the signal from 143 to 0
ENTRYPOINT ["tini", "-v", "-e", "143", "--"]
CMD ["/run.sh"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "asterisk -rx 'core show uptime' | grep uptime"]
