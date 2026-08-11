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

# --- SIP-TLS and SRTP --------------------------------------------------------
#
# Off unless SIP_TLS_ENABLED=true. See config/pjsip_tls.conf for why a TLS block cannot be made
# conditional in place and is therefore a whole file this script keeps or removes.
#
# 5061 is the registered SIPS port; the plaintext transport stays on SIP_BINDADDR (6060) so
# enabling TLS never moves a listener a working fleet is already pointed at.
[ -z "$SIP_TLS_ENABLED" ]              && { export SIP_TLS_ENABLED='false'; }
[ -z "$SIP_TLS_BINDADDR" ]             && { export SIP_TLS_BINDADDR='0.0.0.0:5061'; }
[ -z "$SIP_TLS_CERT_FILE" ]            && { export SIP_TLS_CERT_FILE='/etc/asterisk/certs/asterisk.pem'; }
[ -z "$SIP_TLS_PRIV_KEY_FILE" ]        && { export SIP_TLS_PRIV_KEY_FILE='/etc/asterisk/certs/asterisk-key.pem'; }
# Empty means "send no CA list". Only the leg where Asterisk is the TLS CLIENT (an outbound trunk
# with SIP_TLS_VERIFY_SERVER=yes) needs one; a registering phone is authenticated by SIP digest.
[ -z "$SIP_TLS_CA_FILE" ]              && { export SIP_TLS_CA_FILE=''; }
# The FLOOR, not the ceiling — pjproject reads tlsv1_2 as "1.2 or better".
[ -z "$SIP_TLS_METHOD" ]               && { export SIP_TLS_METHOD='tlsv1_2'; }
[ -z "$SIP_TLS_VERIFY_SERVER" ]        && { export SIP_TLS_VERIFY_SERVER='no'; }
# Which transport the static dev endpoints bind to. `transport-tls` only makes sense with
# SIP_TLS_ENABLED=true, and this script refuses the contradiction below rather than producing two
# endpoints that reference a transport that was deleted.
[ -z "$SIP_ENDPOINT_TRANSPORT" ]       && { export SIP_ENDPOINT_TRANSPORT='transport-tcp'; }
# Offer SRTP, accept a plain answer. `no` makes it mandatory — right for a fleet that must be able
# to prove no media left unencrypted, wrong for a mixed one.
[ -z "$SIP_MEDIA_ENCRYPTION_OPTIMISTIC" ] && { export SIP_MEDIA_ENCRYPTION_OPTIMISTIC='yes'; }
# What the TLS endpoint TEMPLATE offers. Its own variable, and unconditionally `sdes`, because that
# template is on the TLS transport by construction — the SDES key rides in the SDP and is therefore
# safe exactly when the SDP is. Deriving it from SIP_ENDPOINT_TRANSPORT (below) would leave the TLS
# template at `no` on every box whose static dev endpoints happen to be on TCP, which is a TLS
# endpoint carrying plaintext media and looking configured.
[ -z "$SIP_TLS_MEDIA_ENCRYPTION" ]      && { export SIP_TLS_MEDIA_ENCRYPTION='sdes'; }
# DERIVED, not defaulted, and deliberately not settable to `sdes` on a plaintext transport: the
# SDES key rides in the SDP, so `a=crypto` over TCP or UDP publishes it. An operator who sets
# SIP_MEDIA_ENCRYPTION explicitly gets what they asked for; nobody gets it by accident.
if [ -z "$SIP_MEDIA_ENCRYPTION" ]; then
  if [ "$SIP_ENDPOINT_TRANSPORT" = "transport-tls" ]; then
    export SIP_MEDIA_ENCRYPTION='sdes'
  else
    export SIP_MEDIA_ENCRYPTION='no'
  fi
fi
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

sed -i.bak "s|SIP_ENDPOINT_TRANSPORT_PLACEHOLDER|${SIP_ENDPOINT_TRANSPORT}|g" /etc/asterisk/pjsip_dev_endpoints.conf
sed -i.bak "s|SIP_MEDIA_ENCRYPTION_PLACEHOLDER|${SIP_MEDIA_ENCRYPTION}|g" /etc/asterisk/pjsip_dev_endpoints.conf
sed -i.bak "s|SIP_MEDIA_ENCRYPTION_OPTIMISTIC_PLACEHOLDER|${SIP_MEDIA_ENCRYPTION_OPTIMISTIC}|g" /etc/asterisk/pjsip_dev_endpoints.conf

rm /etc/asterisk/*.bak

# --- SIP-TLS ------------------------------------------------------------------------------------
#
# The gate, and the one place this script exits non-zero over a security setting.
#
# An operator who set SIP_TLS_ENABLED=true and whose certificate is missing must NOT get a box that
# came up on the plaintext transport and logged something. That is the failure mode a transport
# security feature cannot have: it looks healthy, phones register, and nothing is encrypted. So a
# missing key is fatal, in the same spirit as the required-variable check above.
if [ "$SIP_TLS_ENABLED" = "true" ]; then
  if [ ! -r "$SIP_TLS_CERT_FILE" ] || [ ! -r "$SIP_TLS_PRIV_KEY_FILE" ]; then
    echo "SIP_TLS_ENABLED=true but the certificate material is not readable:" >&2
    echo "  SIP_TLS_CERT_FILE=${SIP_TLS_CERT_FILE}" >&2
    echo "  SIP_TLS_PRIV_KEY_FILE=${SIP_TLS_PRIV_KEY_FILE}" >&2
    echo "Generate development material with ./config/certs/generate-dev-certs.sh and bring the" >&2
    echo "stack up with -f compose.tls.yaml, or mount production material at those two paths." >&2
    exit 1
  fi
  if [ -n "$SIP_TLS_CA_FILE" ] && [ ! -r "$SIP_TLS_CA_FILE" ]; then
    echo "SIP_TLS_CA_FILE=${SIP_TLS_CA_FILE} is set but not readable" >&2
    exit 1
  fi

  sed -i.bak "s|SIP_TLS_BINDADDR_PLACEHOLDER|${SIP_TLS_BINDADDR}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_TLS_CERT_FILE_PLACEHOLDER|${SIP_TLS_CERT_FILE}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_TLS_PRIV_KEY_FILE_PLACEHOLDER|${SIP_TLS_PRIV_KEY_FILE}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_TLS_METHOD_PLACEHOLDER|${SIP_TLS_METHOD}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_TLS_VERIFY_SERVER_PLACEHOLDER|${SIP_TLS_VERIFY_SERVER}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_TLS_MEDIA_ENCRYPTION_PLACEHOLDER|${SIP_TLS_MEDIA_ENCRYPTION}|g" /etc/asterisk/pjsip_tls.conf
  sed -i.bak "s|SIP_MEDIA_ENCRYPTION_OPTIMISTIC_PLACEHOLDER|${SIP_MEDIA_ENCRYPTION_OPTIMISTIC}|g" /etc/asterisk/pjsip_tls.conf
  # `ca_list_file` with an empty value is not the same as no `ca_list_file`: pjproject treats the
  # empty string as a path and fails to load the transport. The line is DELETED rather than blanked.
  if [ -z "$SIP_TLS_CA_FILE" ]; then
    sed -i.bak "/SIP_TLS_CA_FILE_PLACEHOLDER/d" /etc/asterisk/pjsip_tls.conf
  else
    sed -i.bak "s|SIP_TLS_CA_FILE_PLACEHOLDER|${SIP_TLS_CA_FILE}|g" /etc/asterisk/pjsip_tls.conf
  fi
  rm -f /etc/asterisk/*.bak
  echo "pjsip: TLS transport on ${SIP_TLS_BINDADDR} (cert ${SIP_TLS_CERT_FILE}, method ${SIP_TLS_METHOD})"
  echo "pjsip: media_encryption=${SIP_TLS_MEDIA_ENCRYPTION} optimistic=${SIP_MEDIA_ENCRYPTION_OPTIMISTIC} on the TLS endpoint template"
  echo "pjsip: media_encryption=${SIP_MEDIA_ENCRYPTION} on the static dev endpoints (transport ${SIP_ENDPOINT_TRANSPORT})"
else
  if [ "$SIP_ENDPOINT_TRANSPORT" = "transport-tls" ]; then
    echo "SIP_ENDPOINT_TRANSPORT=transport-tls requires SIP_TLS_ENABLED=true" >&2
    echo "Endpoints would reference a transport this box does not define." >&2
    exit 1
  fi
  rm -f /etc/asterisk/pjsip_tls.conf
  echo "pjsip: no TLS transport (SIP_TLS_ENABLED is not 'true') — signalling on ${SIP_BINDADDR} is plaintext"
fi

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

# Generated CIDR ACLs, if the object store is mounted.
#
# Same delivery as the hold-music classes above and for the same three reasons recorded in
# `apps/api/scripts/generate-musiconhold.ts`: no ARI client in `apps/api`, no AMI client anywhere,
# and neither port reachable from the API in the shipped compose stack. So the API writes a file
# into the object store it already writes media into, and this copies it in at start.
#
# The baked `acl.conf` this replaces declares every named ACL as permit-all, so a deployment with
# no generated file is filtered by nothing — which is what it was before the ACLs existed, and the
# only safe direction for a fallback. Narrowing only ever comes from rows an administrator wrote.
#
# A restart always picks up a change. Without one:
#
#   asterisk -rx 'module reload res_pjsip.so'
#
# — the named ACLs themselves are reloaded by `acl reload`, but the pjsip TRANSPORT caches the
# resolved ACL at load, so the transport is what has to be rebuilt for a change to bite.
if [ -r "${OPTIMIQ_MEDIA_OBJECT_ROOT}/acl/acl.conf" ]; then
  cp "${OPTIMIQ_MEDIA_OBJECT_ROOT}/acl/acl.conf" /etc/asterisk/acl.conf
  echo "acl.conf: using the generated CIDR ACLs from ${OPTIMIQ_MEDIA_OBJECT_ROOT}/acl"
else
  echo "acl.conf: no generated ACLs at ${OPTIMIQ_MEDIA_OBJECT_ROOT}/acl — every named ACL is permit-all."
  echo "  CIDR filtering needs the object store mounted and 'pnpm --filter @optimiq-voice/api generate:sip-acl' run."
fi

asterisk -v

while sleep 3600; do :; done