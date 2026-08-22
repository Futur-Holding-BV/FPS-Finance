#!/usr/bin/env bash
# deploy-finance-vps.sh — Release & deploy fps-finance to FINANCE_VPS_01
# -----------------------------------------------------------------------
# Usage:
#   SSH_USER=deployer bash artifacts/fps-finance/scripts/deploy-finance-vps.sh
#
# Required environment variables:
#   SSH_USER          Remote user with sudo rights; FINANCE_VPS_SSH_USER is the
#                     secret-backed alternative
#
# Optional environment variables:
#   REMOTE_HOST       Target host (default: finance.futurholding.com)
#   SSH_HOST          SSH target (default: REMOTE_HOST; CI uses the pinned VPS IP)
#   SSH_PORT          SSH port (default: 22)
#   DEPLOY_DIR        Remote deploy root (default: /opt/fps-finance)
#   APP_DIR           Local path to fps-finance artifact (default: artifacts/fps-finance)
#   HEALTH_RETRIES    Health-check attempts before rollback (default: 12)
#   HEALTH_INTERVAL   Seconds between health-check attempts (default: 5)
#   CERTBOT_EMAIL     Let's Encrypt contact (default: control@futurholding.com)
#   SYNC_REMOTE_ENV   Set to true when the separate runtime environment must be
#                     installed on the VPS. Provisioning credentials are staged
#                     temporarily on every deployment and are never retained.
#   AUTO_CUTOVER_LEGACY_DATABASE_ROLES
#                     Set to true to perform the guarded one-time finance_app
#                     ownership cutover when the VPS still needs it.
#
# Secrets must NEVER appear in command arguments or script output.
# FINANCE_VPS_SSH_PRIVATE_KEY can supply key-based authentication without
# writing a persistent key file.
# -----------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Config / defaults
# ---------------------------------------------------------------------------
REMOTE_HOST="${REMOTE_HOST:-finance.futurholding.com}"
SSH_HOST="${SSH_HOST:-${REMOTE_HOST}}"
SSH_PORT="${SSH_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/fps-finance}"
APP_DIR="${APP_DIR:-artifacts/fps-finance}"
HEALTH_RETRIES="${HEALTH_RETRIES:-12}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-control@futurholding.com}"
SYNC_REMOTE_ENV="${SYNC_REMOTE_ENV:-false}"
AUTO_CUTOVER_LEGACY_DATABASE_ROLES="${AUTO_CUTOVER_LEGACY_DATABASE_ROLES:-false}"
SSH_USER="${SSH_USER:-${FINANCE_VPS_SSH_USER:-}}"

SERVICE_NAME="fps-finance"
NGINX_CONF_NAME="fps-finance"
LOOPBACK_STATUS="http://127.0.0.1:22044/finance-api/api/finance/status"
PUBLIC_LOGIN="https://${REMOTE_HOST}/"

DEPLOY_CONF_DIR="${APP_DIR}/deploy"
RELEASE_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ARCHIVE="/tmp/fps-finance-${RELEASE_TAG}.tar.gz"
SCHEMA_COMPATIBILITY="$(tr -d '[:space:]' < "${DEPLOY_CONF_DIR}/SCHEMA_COMPATIBILITY")"
SSH_PRIVATE_KEY_FILE=""
SSH_KNOWN_HOSTS_FILE=""
REMOTE_RUNTIME_ENV_FILE=""
REMOTE_PROVISION_ENV_FILE=""
PUBLIC_RESPONSE_FILE=""
REMOTE_RUNTIME_ENV_STAGED=false
REMOTE_PROVISION_ENV_STAGED=false
DEPLOY_LOCK_HELD=false
DEPLOY_LOCK_TOKEN="${RELEASE_TAG}-$$"
DEPLOY_LOCK_DIR="/run/lock/fps-finance-deploy.lock"

cleanup_local_files() {
  if { [[ "${REMOTE_RUNTIME_ENV_STAGED}" == "true" ]] ||
       [[ "${REMOTE_PROVISION_ENV_STAGED}" == "true" ]]; } &&
     [[ -n "${SSH_TARGET:-}" ]]; then
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
      "rm -f /tmp/fps-finance-runtime.env /tmp/fps-finance-provision.env; sudo rm -f /run/fps-finance/provision.env" \
      >/dev/null 2>&1 || true
  fi
  if [[ "${DEPLOY_LOCK_HELD}" == "true" ]] && [[ -n "${SSH_TARGET:-}" ]]; then
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s -- \
      "${DEPLOY_LOCK_DIR}" "${DEPLOY_LOCK_TOKEN}" <<'EOF' >/dev/null 2>&1 || true
set -euo pipefail
lock_dir="$1"
expected_token="$2"
stored_token="$(sudo cat "${lock_dir}/token" 2>/dev/null || true)"
if [[ "${stored_token}" == "${expected_token}" ]]; then
  sudo rm -f "${lock_dir}/token"
  sudo rmdir "${lock_dir}"
fi
EOF
  fi
  rm -f "${RELEASE_ARCHIVE}"
  if [[ -n "${SSH_PRIVATE_KEY_FILE}" ]]; then
    rm -f "${SSH_PRIVATE_KEY_FILE}"
  fi
  if [[ -n "${SSH_KNOWN_HOSTS_FILE}" ]]; then
    rm -f "${SSH_KNOWN_HOSTS_FILE}"
  fi
  if [[ -n "${REMOTE_RUNTIME_ENV_FILE}" ]]; then
    rm -f "${REMOTE_RUNTIME_ENV_FILE}"
  fi
  if [[ -n "${REMOTE_PROVISION_ENV_FILE}" ]]; then
    rm -f "${REMOTE_PROVISION_ENV_FILE}"
  fi
  if [[ -n "${PUBLIC_RESPONSE_FILE}" ]]; then
    rm -f "${PUBLIC_RESPONSE_FILE}"
  fi
}
trap cleanup_local_files EXIT

# ---------------------------------------------------------------------------
# 1. Validate prerequisites
# ---------------------------------------------------------------------------
if [[ -z "${SSH_USER:-}" ]]; then
  echo "ERROR: SSH_USER must be set." >&2
  exit 1
fi
if [[ ! "${SCHEMA_COMPATIBILITY}" =~ ^[a-z0-9-]+$ ]]; then
  echo "ERROR: deploy/SCHEMA_COMPATIBILITY contains an invalid value." >&2
  exit 1
fi

for cmd in node pnpm ssh ssh-keygen rsync tar curl base64 getent; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}" >&2
    exit 1
  fi
done

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
SSH_OPTS=(-o StrictHostKeyChecking=yes -p "${SSH_PORT}")
if [[ -n "${FINANCE_VPS_SSH_KNOWN_HOSTS:-}" ]]; then
  SSH_KNOWN_HOSTS_FILE="$(mktemp)"
  chmod 0600 "${SSH_KNOWN_HOSTS_FILE}"
  printf '%s\n' "${FINANCE_VPS_SSH_KNOWN_HOSTS}" > "${SSH_KNOWN_HOSTS_FILE}"
  SSH_OPTS+=(-o "UserKnownHostsFile=${SSH_KNOWN_HOSTS_FILE}")

  SSH_HOST_LOOKUP="${SSH_HOST}"
  if [[ "${SSH_PORT}" != "22" ]]; then
    SSH_HOST_LOOKUP="[${SSH_HOST}]:${SSH_PORT}"
  fi

  if ! ssh-keygen -F "${SSH_HOST_LOOKUP}" -f "${SSH_KNOWN_HOSTS_FILE}" >/dev/null; then
    SSH_HOST_KEY_ALIAS=""
    while IFS= read -r resolved_ip; do
      SSH_IP_LOOKUP="${resolved_ip}"
      if [[ "${SSH_PORT}" != "22" ]]; then
        SSH_IP_LOOKUP="[${resolved_ip}]:${SSH_PORT}"
      fi
      if ssh-keygen -F "${SSH_IP_LOOKUP}" -f "${SSH_KNOWN_HOSTS_FILE}" >/dev/null; then
        SSH_HOST_KEY_ALIAS="${SSH_IP_LOOKUP}"
        break
      fi
    done < <(getent ahostsv4 "${SSH_HOST}" | awk '{print $1}' | sort -u)

    if [[ -z "${SSH_HOST_KEY_ALIAS}" ]]; then
      echo "ERROR: FINANCE_VPS_SSH_KNOWN_HOSTS does not match ${SSH_HOST} or any resolved IPv4 address." >&2
      exit 1
    fi
    SSH_OPTS+=(-o "HostKeyAlias=${SSH_HOST_KEY_ALIAS}")
  fi
fi
if [[ -n "${FINANCE_VPS_SSH_PRIVATE_KEY:-}" ]]; then
  SSH_PRIVATE_KEY_FILE="$(mktemp)"
  chmod 0600 "${SSH_PRIVATE_KEY_FILE}"
  OPENSSH_KEY_HEADER='-----BEGIN OPENSSH PRIVATE KEY-----'
  OPENSSH_KEY_FOOTER='-----END OPENSSH PRIVATE KEY-----'
  if [[ "${FINANCE_VPS_SSH_PRIVATE_KEY}" == *$'\n'* ]]; then
    printf '%s\n' "${FINANCE_VPS_SSH_PRIVATE_KEY}" > "${SSH_PRIVATE_KEY_FILE}"
  elif [[ "${FINANCE_VPS_SSH_PRIVATE_KEY}" == "${OPENSSH_KEY_HEADER}"*"${OPENSSH_KEY_FOOTER}" ]]; then
    PRIVATE_KEY_BODY="${FINANCE_VPS_SSH_PRIVATE_KEY#"${OPENSSH_KEY_HEADER}"}"
    PRIVATE_KEY_BODY="${PRIVATE_KEY_BODY%"${OPENSSH_KEY_FOOTER}"}"
    PRIVATE_KEY_BODY="$(printf '%s' "${PRIVATE_KEY_BODY}" | tr -d '[:space:]')"
    if [[ ! "${PRIVATE_KEY_BODY}" =~ ^[A-Za-z0-9+/=]+$ ]]; then
      echo "ERROR: FINANCE_VPS_SSH_PRIVATE_KEY contains an invalid single-line OpenSSH key." >&2
      exit 1
    fi
    {
      printf '%s\n' "${OPENSSH_KEY_HEADER}"
      printf '%s' "${PRIVATE_KEY_BODY}" | fold -w 70
      printf '%s\n' "${OPENSSH_KEY_FOOTER}"
    } > "${SSH_PRIVATE_KEY_FILE}"
  elif ! printf '%s' "${FINANCE_VPS_SSH_PRIVATE_KEY}" | base64 --decode > "${SSH_PRIVATE_KEY_FILE}"; then
    echo "ERROR: FINANCE_VPS_SSH_PRIVATE_KEY is neither an OpenSSH private key nor valid base64." >&2
    exit 1
  fi
  if [[ "$(head -n 1 "${SSH_PRIVATE_KEY_FILE}")" != "${OPENSSH_KEY_HEADER}" ]] ||
     [[ "$(tail -n 1 "${SSH_PRIVATE_KEY_FILE}")" != "${OPENSSH_KEY_FOOTER}" ]]; then
    echo "ERROR: decoded FINANCE_VPS_SSH_PRIVATE_KEY has invalid OpenSSH key boundaries." >&2
    exit 1
  fi
  if ! ssh-keygen -y -f "${SSH_PRIVATE_KEY_FILE}" >/dev/null 2>&1; then
    echo "ERROR: FINANCE_VPS_SSH_PRIVATE_KEY could not be parsed as a private key." >&2
    exit 1
  fi
  SSH_OPTS+=(-i "${SSH_PRIVATE_KEY_FILE}" -o IdentitiesOnly=yes)
fi

if ! ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s -- \
  "${DEPLOY_LOCK_DIR}" "${DEPLOY_LOCK_TOKEN}" <<'EOF'
set -euo pipefail
lock_dir="$1"
lock_token="$2"
if ! sudo mkdir -m 0700 "${lock_dir}"; then
  echo "ERROR: another FPS Finance deployment holds ${lock_dir}; inspect it before retrying." >&2
  exit 75
fi
if ! printf '%s\n' "${lock_token}" | sudo tee "${lock_dir}/token" >/dev/null; then
  sudo rmdir "${lock_dir}" || true
  exit 1
fi
sudo chmod 0600 "${lock_dir}/token"
EOF
then
  echo "ERROR: could not acquire the exclusive remote deployment lock." >&2
  exit 1
fi
DEPLOY_LOCK_HELD=true

FINANCE_RUNTIME_DATABASE_ROLE="${FINANCE_RUNTIME_DATABASE_ROLE:-fps_finance_app}"
if [[ ! "${FINANCE_RUNTIME_DATABASE_ROLE}" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "ERROR: FINANCE_RUNTIME_DATABASE_ROLE must be a simple lowercase PostgreSQL identifier." >&2
  exit 1
fi
if [[ -z "${FINANCE_MIGRATION_DATABASE_URL:-}" ||
      -z "${FINANCE_RUNTIME_DATABASE_PASSWORD:-}" ]]; then
  echo "ERROR: deployments require FINANCE_MIGRATION_DATABASE_URL and FINANCE_RUNTIME_DATABASE_PASSWORD." >&2
  exit 1
fi
if [[ "${#FINANCE_RUNTIME_DATABASE_PASSWORD}" -lt 20 ]]; then
  echo "ERROR: FINANCE_RUNTIME_DATABASE_PASSWORD must contain at least 20 characters." >&2
  exit 1
fi

write_env_value() {
  local output_file="$1"
  local variable_name="$2"
  local variable_value="$3"
  if [[ "${variable_value}" == *$'\n'* || "${variable_value}" == *$'\r'* ]]; then
    echo "ERROR: ${variable_name} must not contain line breaks." >&2
    exit 1
  fi
  ENV_VALUE="${variable_value}" node -e \
    'process.stdout.write(process.env.ENV_VALUE === undefined ? "\"\"" : JSON.stringify(process.env.ENV_VALUE))' \
    | {
        printf '%s=' "${variable_name}" >> "${output_file}"
        cat >> "${output_file}"
        printf '\n' >> "${output_file}"
      }
}

REMOTE_PROVISION_ENV_FILE="$(mktemp)"
chmod 0600 "${REMOTE_PROVISION_ENV_FILE}"
write_env_value "${REMOTE_PROVISION_ENV_FILE}" \
  FINANCE_MIGRATION_DATABASE_URL "${FINANCE_MIGRATION_DATABASE_URL}"
write_env_value "${REMOTE_PROVISION_ENV_FILE}" \
  FINANCE_RUNTIME_DATABASE_ROLE "${FINANCE_RUNTIME_DATABASE_ROLE}"
write_env_value "${REMOTE_PROVISION_ENV_FILE}" \
  FINANCE_RUNTIME_DATABASE_PASSWORD "${FINANCE_RUNTIME_DATABASE_PASSWORD}"
write_env_value "${REMOTE_PROVISION_ENV_FILE}" \
  FINANCE_DEPLOY_ID "${RELEASE_TAG}"

if [[ "${SYNC_REMOTE_ENV}" == "true" ]]; then
  required_runtime_variables=(
    FINANCE_SESSION_SECRET
    FINANCE_ENCRYPTION_KEY
    FINANCE_GRAPH_TENANT_ID
    FINANCE_GRAPH_CLIENT_ID
    FINANCE_GRAPH_CLIENT_SECRET
  )
  for variable_name in "${required_runtime_variables[@]}"; do
    if [[ -z "${!variable_name:-}" ]]; then
      echo "ERROR: SYNC_REMOTE_ENV=true requires ${variable_name}." >&2
      exit 1
    fi
  done
  if [[ "${#FINANCE_SESSION_SECRET}" -lt 32 ]]; then
    echo "ERROR: FINANCE_SESSION_SECRET must contain at least 32 characters." >&2
    exit 1
  fi

  FINANCE_RUNTIME_DATABASE_URL="$(
    MIGRATION_DATABASE_URL="${FINANCE_MIGRATION_DATABASE_URL}" \
    RUNTIME_DATABASE_ROLE="${FINANCE_RUNTIME_DATABASE_ROLE}" \
    RUNTIME_DATABASE_PASSWORD="${FINANCE_RUNTIME_DATABASE_PASSWORD}" \
    node <<'NODE'
const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(url.protocol)) {
  throw new Error("FINANCE_MIGRATION_DATABASE_URL must use PostgreSQL.");
}
if (decodeURIComponent(url.pathname.replace(/^\/+/, "")) !== "fps_finance") {
  throw new Error("FINANCE_MIGRATION_DATABASE_URL must target fps_finance.");
}
if (decodeURIComponent(url.username) !== "fps_finance_migrator") {
  throw new Error("FINANCE_MIGRATION_DATABASE_URL must use fps_finance_migrator.");
}
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())) {
  throw new Error("FINANCE_MIGRATION_DATABASE_URL must use the VPS loopback database.");
}
url.username = process.env.RUNTIME_DATABASE_ROLE;
url.password = process.env.RUNTIME_DATABASE_PASSWORD;
process.stdout.write(url.toString());
NODE
  )"

  REMOTE_RUNTIME_ENV_FILE="$(mktemp)"
  chmod 0600 "${REMOTE_RUNTIME_ENV_FILE}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_DATABASE_URL "${FINANCE_RUNTIME_DATABASE_URL}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_SESSION_SECRET "${FINANCE_SESSION_SECRET}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_ENCRYPTION_KEY "${FINANCE_ENCRYPTION_KEY}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_PUBLIC_URL "https://${REMOTE_HOST}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_GRAPH_TENANT_ID "${FINANCE_GRAPH_TENANT_ID}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_GRAPH_CLIENT_ID "${FINANCE_GRAPH_CLIENT_ID}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_GRAPH_CLIENT_SECRET "${FINANCE_GRAPH_CLIENT_SECRET}"
  write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
    FINANCE_GRAPH_SENDER "control@futurholding.com"

  optional_runtime_variables=(
    FINANCE_BOOTSTRAP_EMAIL
    FINANCE_BOOTSTRAP_ROLES
    FINANCE_CONNECT_SYNC_URL
    FINANCE_CONNECT_SYNC_TOKEN
    FINANCE_CONNECT_INVOICE_URL
    FINANCE_CONNECT_INVOICE_TOKEN
    FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP
    FINANCE_ONE_PLATFORM_INVOICE_URL
    FINANCE_ONE_PLATFORM_INVOICE_TOKEN
    FINANCE_ONE_PLATFORM_ADMINISTRATION_ID
    LOG_LEVEL
  )
  for variable_name in "${optional_runtime_variables[@]}"; do
    if [[ -n "${!variable_name:-}" ]]; then
      write_env_value "${REMOTE_RUNTIME_ENV_FILE}" \
        "${variable_name}" "${!variable_name}"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 2. Build locally
# ---------------------------------------------------------------------------
echo "==> [1/7] Building fps-finance locally (tag: ${RELEASE_TAG})..."
(
  cd "${APP_DIR}"
  BASE_PATH=/ PORT=22044 pnpm run build
)

if [[ -n "${REMOTE_RUNTIME_ENV_FILE}" ]]; then
  (
    set -a
    # The generated file uses JSON-compatible quoting and contains no commands.
    # shellcheck disable=SC1090
    source "${REMOTE_RUNTIME_ENV_FILE}"
    set +a
    env -u DATABASE_URL -u SESSION_SECRET \
      NODE_ENV=production \
      node "${APP_DIR}/dist/validate-production-config.mjs"
  )
fi

# ---------------------------------------------------------------------------
# 3. Create versioned release archive
# ---------------------------------------------------------------------------
echo "==> [2/7] Creating release archive ${RELEASE_ARCHIVE}..."
tar -czf "${RELEASE_ARCHIVE}" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='src' \
  --exclude='*.test.*' \
  -C "${APP_DIR}" \
  dist \
  drizzle \
  deploy/SCHEMA_COMPATIBILITY \
  package.json

echo "    Archive size: $(du -sh "${RELEASE_ARCHIVE}" | cut -f1)"

# ---------------------------------------------------------------------------
# 4. Transfer release and deploy configs via SSH/rsync
# ---------------------------------------------------------------------------
echo "==> [3/7] Transferring release to ${SSH_TARGET}:${DEPLOY_DIR}/releases/${RELEASE_TAG}..."

# Create remote release directory
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  "mkdir -p '${DEPLOY_DIR}/releases/${RELEASE_TAG}'"

# Transfer archive
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${RELEASE_ARCHIVE}" \
  "${SSH_TARGET}:${DEPLOY_DIR}/releases/${RELEASE_TAG}/release.tar.gz"

# Expand archive on remote
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s <<EOF
  set -euo pipefail
  cd '${DEPLOY_DIR}/releases/${RELEASE_TAG}'
  tar -xzf release.tar.gz
  rm release.tar.gz
  printf '%s\n' '${RELEASE_TAG}' > deploy/RELEASE_ID
  chmod 0444 deploy/RELEASE_ID
EOF

# Transfer systemd unit
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${DEPLOY_CONF_DIR}/fps-finance.service" \
  "${SSH_TARGET}:/tmp/fps-finance.service"

# Transfer one-shot database provision unit
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${DEPLOY_CONF_DIR}/fps-finance-provision.service" \
  "${SSH_TARGET}:/tmp/fps-finance-provision.service"

# Transfer the guarded one-time legacy role cutover unit
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${DEPLOY_CONF_DIR}/fps-finance-role-cutover.service" \
  "${SSH_TARGET}:/tmp/fps-finance-role-cutover.service"

# Transfer Nginx config
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${DEPLOY_CONF_DIR}/fps-finance.nginx.conf" \
  "${SSH_TARGET}:/tmp/fps-finance.nginx.conf"

# Transfer the HTTP-only first-certificate bootstrap config
rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${DEPLOY_CONF_DIR}/fps-finance.nginx.bootstrap.conf" \
  "${SSH_TARGET}:/tmp/fps-finance.nginx.bootstrap.conf"

rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
  "${REMOTE_PROVISION_ENV_FILE}" \
  "${SSH_TARGET}:/tmp/fps-finance-provision.env"
REMOTE_PROVISION_ENV_STAGED=true

if [[ -n "${REMOTE_RUNTIME_ENV_FILE}" ]]; then
  rsync -az --rsh="ssh ${SSH_OPTS[*]}" \
    "${REMOTE_RUNTIME_ENV_FILE}" \
    "${SSH_TARGET}:/tmp/fps-finance-runtime.env"
  REMOTE_RUNTIME_ENV_STAGED=true
fi

# ---------------------------------------------------------------------------
# 5. Atomic activation — install configs and flip symlink
# ---------------------------------------------------------------------------
echo "==> [4/7] Activating release ${RELEASE_TAG} on remote..."

read_remote_current_release() {
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s -- "${DEPLOY_DIR}" <<'EOF'
    set -euo pipefail
    deploy_dir="$1"
    candidate="$(readlink -f "${deploy_dir}/current" 2>/dev/null || true)"
    if [[ -n "${candidate}" ]] &&
       [[ -d "${candidate}" ]] &&
       [[ "${candidate}" == "${deploy_dir}/releases/"* ]]; then
      printf '%s\n' "${candidate}"
    fi
EOF
}

PREVIOUS_RELEASE="$(read_remote_current_release)"

recover_failed_release() {
  local failed_release="${DEPLOY_DIR}/releases/${RELEASE_TAG}"
  local current_release
  current_release="$(read_remote_current_release)"

  if [[ "${current_release}" != "${failed_release}" ]]; then
    echo "    Activation did not switch the current release; no code rollback is needed."
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
      "sudo systemctl restart '${SERVICE_NAME}' || true"
    return
  fi

  if [[ -n "${PREVIOUS_RELEASE}" ]] &&
     ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
       "grep -Fxq '${SCHEMA_COMPATIBILITY}' '${PREVIOUS_RELEASE}/deploy/SCHEMA_COMPATIBILITY' 2>/dev/null"; then
    echo "==> Rolling back symlink to ${PREVIOUS_RELEASE}..."
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s <<RBEOF
      set -euo pipefail
      ln -sfn '${PREVIOUS_RELEASE}' '${DEPLOY_DIR}/next'
      mv -Tf '${DEPLOY_DIR}/next' '${DEPLOY_DIR}/current'
      sudo systemctl restart '${SERVICE_NAME}' || true
RBEOF
    echo "    Code rollback complete to a public-schema-compatible release."
  else
    echo "    No public-schema-compatible previous release exists; automatic rollback is unsafe." >&2
    echo "    Keeping the new release selected and stopping the app for a forward fix." >&2
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
      "sudo systemctl stop '${SERVICE_NAME}' || true"
  fi
}

if ! ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s <<EOF
  set -euo pipefail

  DEPLOY_DIR='${DEPLOY_DIR}'
  RELEASE_TAG='${RELEASE_TAG}'
  NGINX_CONF_NAME='${NGINX_CONF_NAME}'
  SERVICE_NAME='${SERVICE_NAME}'
  PROVISION_SERVICE_NAME='fps-finance-provision'
  CUTOVER_SERVICE_NAME='fps-finance-role-cutover'
  AUTO_CUTOVER_LEGACY_DATABASE_ROLES='${AUTO_CUTOVER_LEGACY_DATABASE_ROLES}'
  CERTBOT_EMAIL='${CERTBOT_EMAIL}'
  CERTIFICATE_PATH='/etc/letsencrypt/live/${REMOTE_HOST}/fullchain.pem'

  cleanup_staged_secrets() {
    rm -f /tmp/fps-finance-runtime.env /tmp/fps-finance-provision.env
    sudo rm -f /run/fps-finance/provision.env /run/fps-finance/cutover.env
  }
  trap cleanup_staged_secrets EXIT

  # --- Optional runtime secret installation (content never logged) ---
  if [[ -f /tmp/fps-finance-runtime.env ]]; then
    sudo install -d -o root -g fps-finance -m 0750 /etc/fps-finance
    sudo install -o root -g fps-finance -m 0640 \
      /tmp/fps-finance-runtime.env \
      /etc/fps-finance/.runtime.env.\${RELEASE_TAG}
    sudo mv -f \
      /etc/fps-finance/.runtime.env.\${RELEASE_TAG} \
      /etc/fps-finance/runtime.env
    rm -f /tmp/fps-finance-runtime.env
  fi

  # --- First-certificate bootstrap over HTTP when needed ---
  if ! sudo test -s "\${CERTIFICATE_PATH}"; then
    command -v certbot >/dev/null 2>&1 || {
      echo 'ERROR: certbot is required for first TLS bootstrap.' >&2
      exit 1
    }
    sudo install -d -o root -g root -m 0755 /var/www/certbot
    sudo install -o root -g root -m 0644 \
      /tmp/fps-finance.nginx.bootstrap.conf \
      /etc/nginx/sites-available/\${NGINX_CONF_NAME}
    sudo ln -sf \
      /etc/nginx/sites-available/\${NGINX_CONF_NAME} \
      /etc/nginx/sites-enabled/\${NGINX_CONF_NAME}
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl enable --now nginx
    sudo systemctl reload nginx
    sudo certbot certonly \
      --webroot \
      --webroot-path /var/www/certbot \
      --domain '${REMOTE_HOST}' \
      --non-interactive \
      --agree-tos \
      --email "\${CERTBOT_EMAIL}"
  fi

  # --- Install and validate the full TLS vhost ---
  sudo install -o root -g root -m 0644 \
    /tmp/fps-finance.nginx.conf \
    /etc/nginx/sites-available/\${NGINX_CONF_NAME}
  sudo ln -sf \
    /etc/nginx/sites-available/\${NGINX_CONF_NAME} \
    /etc/nginx/sites-enabled/\${NGINX_CONF_NAME}
  rm -f /tmp/fps-finance.nginx.conf /tmp/fps-finance.nginx.bootstrap.conf
  sudo nginx -t

  # --- Stop the old process before any schema migration ---
  sudo systemctl stop \${SERVICE_NAME} 2>/dev/null || true
  if sudo systemctl is-active --quiet \${SERVICE_NAME}; then
    echo 'ERROR: the previous FPS Finance process is still active.' >&2
    exit 1
  fi

  # --- Atomic symlink flip ---
  ln -sfn "\${DEPLOY_DIR}/releases/\${RELEASE_TAG}" "\${DEPLOY_DIR}/next"
  mv -Tf "\${DEPLOY_DIR}/next" "\${DEPLOY_DIR}/current"
  selected_release="\$(readlink -f "\${DEPLOY_DIR}/current")"
  if [[ "\${selected_release}" != "\${DEPLOY_DIR}/releases/\${RELEASE_TAG}" ]]; then
    echo 'ERROR: current does not identify the release being provisioned.' >&2
    exit 1
  fi
  grep -Fxq '\${RELEASE_TAG}' "\${selected_release}/deploy/RELEASE_ID"
  grep -Fxq '${SCHEMA_COMPATIBILITY}' "\${selected_release}/deploy/SCHEMA_COMPATIBILITY"

  # --- Install units only after current points at the complete new release ---
  sudo install -o root -g root -m 0644 \
    /tmp/fps-finance.service \
    /etc/systemd/system/\${SERVICE_NAME}.service
  rm -f /tmp/fps-finance.service

  sudo install -o root -g root -m 0644 \
    /tmp/fps-finance-provision.service \
    /etc/systemd/system/\${PROVISION_SERVICE_NAME}.service
  rm -f /tmp/fps-finance-provision.service

  sudo install -o root -g root -m 0644 \
    /tmp/fps-finance-role-cutover.service \
    /etc/systemd/system/\${CUTOVER_SERVICE_NAME}.service
  rm -f /tmp/fps-finance-role-cutover.service
  sudo systemctl daemon-reload

  # --- Provision with a short-lived root-only environment ---
  if [[ ! -f /tmp/fps-finance-provision.env ]]; then
    echo 'ERROR: temporary Finance provisioning environment is missing.' >&2
    exit 1
  fi
  sudo install -d -o root -g root -m 0700 /run/fps-finance
  sudo install -o root -g root -m 0600 \
    /tmp/fps-finance-provision.env \
    /run/fps-finance/provision.env
  rm -f /tmp/fps-finance-provision.env

  # --- Guarded one-time migration from the legacy finance_app owner ---
  legacy_cutover_needed="\$(sudo -u postgres psql \
    --dbname=postgres \
    --no-password \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command="SELECT CASE WHEN
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finance_app' AND rolcanlogin)
      OR EXISTS (
        SELECT 1
        FROM pg_database d
        JOIN pg_roles r ON r.oid = d.datdba
        WHERE d.datname = 'fps_finance' AND r.rolname = 'finance_app'
      )
      THEN 'yes' ELSE 'no' END")"
  if [[ "\${legacy_cutover_needed}" == "yes" ]]; then
    if [[ "\${AUTO_CUTOVER_LEGACY_DATABASE_ROLES}" != "true" ]]; then
      echo 'ERROR: legacy Finance database roles require the guarded cutover flag.' >&2
      exit 1
    fi
    backup_dir='/var/backups/fps-finance'
    backup_tmp="/tmp/fps-finance-pre-role-cutover-\${RELEASE_TAG}.dump"
    backup_final="\${backup_dir}/pre-role-cutover-\${RELEASE_TAG}.dump"
    sudo install -d -o root -g root -m 0700 "\${backup_dir}"
    sudo -u postgres pg_dump \
      --dbname=fps_finance \
      --format=custom \
      --file="\${backup_tmp}"
    sudo -u postgres pg_restore --list "\${backup_tmp}" >/dev/null
    backup_sha256="\$(sudo sha256sum "\${backup_tmp}" | awk '{print \$1}')"
    sudo install -o root -g root -m 0600 "\${backup_tmp}" "\${backup_final}"
    sudo rm -f "\${backup_tmp}"

    sudo cp /run/fps-finance/provision.env /run/fps-finance/cutover.env
    printf 'FINANCE_CUTOVER_BACKUP_SHA256="%s"\n' "\${backup_sha256}" \
      | sudo tee -a /run/fps-finance/cutover.env >/dev/null
    sudo chmod 0600 /run/fps-finance/cutover.env
    sudo systemctl restart "\${CUTOVER_SERVICE_NAME}"
    if sudo test -e /run/fps-finance/cutover.env; then
      echo 'ERROR: role-cutover credentials remained after the oneshot unit.' >&2
      exit 1
    fi
    echo "    Legacy database-role cutover completed; backup: \${backup_final}"
  fi

  sudo systemctl restart \${PROVISION_SERVICE_NAME}
  if sudo test -e /run/fps-finance/provision.env; then
    echo 'ERROR: provisioning credentials remained after the oneshot unit.' >&2
    exit 1
  fi
  sudo -u postgres psql \
    --dbname=postgres \
    --no-password \
    --set=ON_ERROR_STOP=1 \
    --command='ALTER ROLE fps_finance_migrator NOCREATEROLE'

  # --- Reload Nginx ---
  sudo systemctl reload nginx

  # --- Restart the runtime after successful provisioning ---
  sudo systemctl enable \${SERVICE_NAME}
  sudo systemctl restart \${SERVICE_NAME}
  sudo systemctl is-active --quiet \${SERVICE_NAME}
EOF
then
  echo "ERROR: Remote activation or database provisioning failed." >&2
  recover_failed_release
  exit 2
fi
REMOTE_RUNTIME_ENV_STAGED=false
REMOTE_PROVISION_ENV_STAGED=false

# ---------------------------------------------------------------------------
# 6. Health checks
# ---------------------------------------------------------------------------
echo "==> [5/7] Running health checks (${HEALTH_RETRIES} attempts × ${HEALTH_INTERVAL}s)..."

attempt=0
loopback_ok=false
while [[ ${attempt} -lt ${HEALTH_RETRIES} ]]; do
  attempt=$(( attempt + 1 ))
  status_code="$(ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "curl -sS -o /dev/null -w '%{http_code}' '${LOOPBACK_STATUS}' 2>/dev/null || true")"
  if [[ ! "${status_code}" =~ ^[0-9]{3}$ ]]; then
    status_code="000"
  fi
  if [[ "${status_code}" == "200" ]]; then
    echo "    Loopback status OK (HTTP 200) after ${attempt} attempt(s)."
    loopback_ok=true
    break
  fi
  echo "    Attempt ${attempt}/${HEALTH_RETRIES}: loopback returned HTTP ${status_code}, retrying in ${HEALTH_INTERVAL}s..."
  sleep "${HEALTH_INTERVAL}"
done

if [[ "${loopback_ok}" != "true" ]]; then
  echo "ERROR: Loopback health check failed after ${HEALTH_RETRIES} attempts." >&2
  recover_failed_release
  exit 2
fi

# Public HTTPS smoke-test
echo "==> [6/7] Smoke-testing public HTTPS endpoint ${PUBLIC_LOGIN}..."
PUBLIC_RESPONSE_FILE="$(mktemp)"
public_result="$(curl -sS --location \
  --proto '=https' \
  --proto-redir '=https' \
  --max-redirs 3 \
  -o "${PUBLIC_RESPONSE_FILE}" \
  -w $'%{http_code}\t%{url_effective}' \
  --max-time 15 "${PUBLIC_LOGIN}" 2>/dev/null || true)"
IFS=$'\t' read -r public_code public_effective_url <<< "${public_result}"
if [[ ! "${public_code}" =~ ^[0-9]{3}$ ]]; then
  public_code="000"
fi
if [[ "${public_code}" == "200" ]] &&
   [[ "${public_effective_url}" == "https://${REMOTE_HOST}/"* ]] &&
   grep -Fq '<title>FPS Finance</title>' "${PUBLIC_RESPONSE_FILE}" &&
   grep -Fq '<div id="root"></div>' "${PUBLIC_RESPONSE_FILE}"; then
  echo "    Public FPS Finance login shell OK (HTTP 200 at ${public_effective_url})."
else
  echo "ERROR: Public HTTPS did not return the FPS Finance login shell (HTTP ${public_code}); rolling back." >&2
  recover_failed_release
  exit 2
fi

if [[ "${SYNC_REMOTE_ENV}" == "true" ]]; then
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "sudo rm -f /etc/fps-finance/env"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup old releases (keep last 5)
# ---------------------------------------------------------------------------
echo "==> [7/7] Pruning old releases (keeping 5 most recent)..."
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s <<EOF
  set -euo pipefail
  cd '${DEPLOY_DIR}/releases'
  ls -1t | tail -n +6 | xargs -r rm -rf
EOF

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "✓ Deployment of fps-finance ${RELEASE_TAG} to ${REMOTE_HOST} completed successfully."
echo "  Service : ${SERVICE_NAME}"
echo "  Release : ${DEPLOY_DIR}/releases/${RELEASE_TAG}"
echo "  Current : ${DEPLOY_DIR}/current -> ${RELEASE_TAG}"
echo ""
