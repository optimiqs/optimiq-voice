#!/usr/bin/env sh

set -e

USAGE=$(cat <<-END
To run this image you must provide the following environment variables:
  ARI_USERNAME
  ARI_SECRET
  SIPPROXY_HOST
  SIPPROXY_USERNAME
  SIPPROXY_SECRET
  RTP_PORT_START
  RTP_PORT_END
END
)

# Default environment variables
[ -z "$HTTP_BINDADDR" ]       && { export HTTP_BINDADDR='0.0.0.0'; }
[ -z "$SIP_BINDADDR" ]        && { export SIP_BINDADDR='0.0.0.0:6060'; }
[ -z "$SIPPROXY_PORT" ]       && { export SIPPROXY_PORT='5060'; }
[ -z "$CODECS" ]              && { export CODECS='g722,ulaw,alaw,gsm'; }
[ -z "$DTMF_MODE" ]           && { export DTMF_MODE='rfc2833'; }
# The Stasis application `extensions.conf`'s Optimiq contexts hand channels to.
# Must match apps/engine's ARI_APP, or inbound calls ring into a dead app.
[ -z "$OPTIMIQ_ARI_APP" ]     && { export OPTIMIQ_ARI_APP='optimiq-engine'; }
# Read by ${ENV(OPTIMIQ_DEV_ORG_ID)} in the dialplan. Deliberately has NO
# default: an unset value makes the engine reject the call with INVALID_PROFILE,
# which is the correct outcome for a box nobody has told which tenant it serves.

# Required environment variables
[ -z "$ARI_USERNAME" ]          ||
[ -z "$ARI_SECRET" ]            ||
[ -z "$RTP_PORT_START" ]        ||
[ -z "$RTP_PORT_END" ]          ||
[ -z "$SIPPROXY_HOST" ]         ||
[ -z "$SIPPROXY_USERNAME" ]     ||
[ -z "$SIPPROXY_SECRET" ]   && {
  echo "$USAGE"
  exit 1
}

sed -i.bak "s|ARI_USERNAME_PLACEHOLDER|${ARI_USERNAME}|g" /etc/asterisk/ari.conf
sed -i.bak "s|ARI_SECRET_PLACEHOLDER|${ARI_SECRET}|g" /etc/asterisk/ari.conf
sed -i.bak "s|SIP_BINDADDR_PLACEHOLDER|${SIP_BINDADDR}|g" /etc/asterisk/pjsip.conf
sed -i.bak "s|HTTP_BINDADDR_PLACEHOLDER|${HTTP_BINDADDR}|g" /etc/asterisk/http.conf
sed -i.bak "s|SIPPROXY_HOST_PLACEHOLDER|${SIPPROXY_HOST}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|SIPPROXY_PORT_PLACEHOLDER|${SIPPROXY_PORT}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|SIPPROXY_USERNAME_PLACEHOLDER|${SIPPROXY_USERNAME}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|SIPPROXY_SECRET_PLACEHOLDER|${SIPPROXY_SECRET}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|DTMF_MODE_PLACEHOLDER|${DTMF_MODE}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|CODECS_PLACEHOLDER|${CODECS}|g" /etc/asterisk/pjsip_wizard.conf
sed -i.bak "s|RTP_PORT_START_PLACEHOLDER|${RTP_PORT_START}|g" /etc/asterisk/rtp.conf
sed -i.bak "s|RTP_PORT_END_PLACEHOLDER|${RTP_PORT_END}|g" /etc/asterisk/rtp.conf

rm /etc/asterisk/*.bak

# Static SIP credentials ship in the image but are removed unless explicitly
# enabled. Fail-safe by default: the box that forgets to set this flag is the
# box with no shared passwords on it, not the other way round.
if [ "$OPTIMIQ_DEV_ENDPOINTS" != "true" ]; then
  rm -f /etc/asterisk/pjsip_dev_endpoints.conf
fi

# Tenant music-on-hold classes, if the object store is mounted.
#
# A hold-music class is a row in `moh_class` and a section in this file, and Asterisk resolves a
# class by NAME against the file — never by path. So the audio the API uploads under
# `<root>/moh/<org>/<class>/` is invisible to `res_musiconhold` until something declares the class.
#
# `apps/api`'s `generate:musiconhold` renders that declaration into `<root>/moh/musiconhold.conf`,
# in the object store the media server already mounts — deliberately, so tenant hold music needs no
# SECOND mount that a deployment can forget. This copies it over the baked fallback if it is there.
#
# Copied rather than symlinked or `#include`d: `/etc/asterisk` is owned by the `asterisk` user and
# the mount is read-only, and a copy is also what makes the running configuration a snapshot — a
# regeneration mid-call cannot change what this process resolves until somebody reloads.
#
# A restart therefore always picks up a change. Without one:
#
#   asterisk -rx 'module reload res_musiconhold.so'
#
# The absence of the file is NOT an error: a deployment with no object-store mount, or one that has
# never generated it, keeps the baked `[default]` class and hears the stock hold music.
[ -z "$OPTIMIQ_MEDIA_OBJECT_ROOT" ] && { export OPTIMIQ_MEDIA_OBJECT_ROOT='/var/lib/optimiq/objects'; }
if [ -r "${OPTIMIQ_MEDIA_OBJECT_ROOT}/moh/musiconhold.conf" ]; then
  cp "${OPTIMIQ_MEDIA_OBJECT_ROOT}/moh/musiconhold.conf" /etc/asterisk/musiconhold.conf
  echo "musiconhold.conf: using the generated classes from ${OPTIMIQ_MEDIA_OBJECT_ROOT}/moh"
else
  echo "musiconhold.conf: no generated classes at ${OPTIMIQ_MEDIA_OBJECT_ROOT}/moh — only [default] is declared."
  echo "  Tenant hold music needs the object store mounted and 'pnpm --filter @optimiq-voice/api generate:musiconhold' run."
fi

asterisk -v

while sleep 3600; do :; done