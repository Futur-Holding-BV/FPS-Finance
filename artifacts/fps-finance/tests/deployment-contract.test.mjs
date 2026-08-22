import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(artifactRoot, relativePath), "utf8");
}

function assertOrdered(content, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const index = content.indexOf(marker);
    assert.notEqual(index, -1, `Missing deployment marker: ${marker}`);
    assert.ok(index > previousIndex, `Deployment marker is out of order: ${marker}`);
    previousIndex = index;
  }
}

test("VPS release stops old code before provisioning and starts new code afterwards", async () => {
  const script = await read("scripts/deploy-finance-vps.sh");

  assertOrdered(script, [
    "sudo systemctl stop \\${SERVICE_NAME}",
    'mv -Tf "\\${DEPLOY_DIR}/next" "\\${DEPLOY_DIR}/current"',
    "sudo systemctl restart \\${PROVISION_SERVICE_NAME}",
    "sudo systemctl restart \\${SERVICE_NAME}",
  ]);
  assert.match(script, /drizzle\s+\\\n\s+deploy\/SCHEMA_COMPATIBILITY/);
  assert.match(script, /fps-finance\.nginx\.bootstrap\.conf/);
  assert.match(script, /certbot certonly/);
  assert.match(script, /candidate.*deploy_dir.*releases/s);
  assert.doesNotMatch(script, /readlink -f '\$\{DEPLOY_DIR\}\/current'.*\|\| echo ''/);
  assert.match(script, /REMOTE_PROVISION_ENV_STAGED.*provision\.env/s);
  assert.match(script, /FINANCE_MIGRATION_DATABASE_URL/);
  assert.match(script, /FINANCE_RUNTIME_DATABASE_PASSWORD/);
  assert.match(script, /fps-finance-deploy\.lock/);
  assert.match(script, /AUTO_CUTOVER_LEGACY_DATABASE_ROLES/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore --list/);
  assert.match(script, /finance-role-cutover/);
  assert.match(script, /\/run\/fps-finance\/provision\.env/);
  assert.match(script, /sudo rm -f \/etc\/fps-finance\/env/);
  assert.match(script, /public_result=.*curl -sS --location/s);
  assert.match(script, /--proto-redir '=https'/);
  assert.match(script, /public_code.*== "200"/s);
  assert.match(script, /<title>FPS Finance<\/title>/);
  assert.match(script, /<div id="root"><\/div>/);
});

test("systemd separates runtime and temporary privileged credentials", async () => {
  const [appUnit, provisionUnit, cutoverUnit] = await Promise.all([
    read("deploy/fps-finance.service"),
    read("deploy/fps-finance-provision.service"),
    read("deploy/fps-finance-role-cutover.service"),
  ]);

  assert.doesNotMatch(appUnit, /^Requires=fps-finance-provision\.service$/m);
  assert.doesNotMatch(appUnit, /^After=fps-finance-provision\.service$/m);
  assert.match(appUnit, /^EnvironmentFile=\/etc\/fps-finance\/runtime\.env$/m);
  assert.match(appUnit, /^ExecStartPre=.*finance-database\.mjs verify$/m);
  assert.match(appUnit, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(provisionUnit, /^RemainAfterExit=/m);
  assert.match(provisionUnit, /^EnvironmentFile=\/run\/fps-finance\/provision\.env$/m);
  assert.match(provisionUnit, /^ExecStopPost=\+\/usr\/bin\/rm -f \/run\/fps-finance\/provision\.env$/m);
  assert.match(provisionUnit, /^ReadWritePaths=\/run\/fps-finance$/m);
  assert.doesNotMatch(provisionUnit, /^ReadOnlyPaths=.*provision\.env/m);
  assert.match(provisionUnit, /finance-database\.mjs provision/);
  assert.match(cutoverUnit, /^User=postgres$/m);
  assert.match(cutoverUnit, /^EnvironmentFile=\/run\/fps-finance\/cutover\.env$/m);
  assert.match(cutoverUnit, /^ReadWritePaths=\/run\/fps-finance$/m);
  assert.doesNotMatch(cutoverUnit, /^ReadOnlyPaths=.*cutover\.env/m);
  assert.match(cutoverUnit, /finance-role-cutover\.mjs --apply/);
});

test("Nginx has an HTTP certificate bootstrap and a loopback-only TLS proxy", async () => {
  const [bootstrap, tlsConfig] = await Promise.all([
    read("deploy/fps-finance.nginx.bootstrap.conf"),
    read("deploy/fps-finance.nginx.conf"),
  ]);

  assert.match(bootstrap, /listen 80;/);
  assert.doesNotMatch(bootstrap, /listen 443/);
  assert.match(tlsConfig, /listen 443 ssl;/);
  assert.match(tlsConfig, /proxy_pass http:\/\/127\.0\.0\.1:22044;/);
  assert.doesNotMatch(tlsConfig, /\$connection_upgrade/);
});

test("GitHub deploy waits for green CI and invokes the audited VPS release script", async () => {
  const [ci, deploy] = await Promise.all([
    read("../../.github/workflows/ci.yml"),
    read("../../.github/workflows/deploy.yml"),
  ]);

  assert.match(ci, /^name: CI$/m);
  assert.match(ci, /^    name: Typecheck & build$/m);
  assert.match(ci, /pnpm --filter @workspace\/fps-finance test/);
  assert.match(deploy, /CI-poort — controleer CI-status op deze commit/);
  assert.match(deploy, /r\.name === 'Typecheck & build'/);
  assert.match(deploy, /SSH_HOST=136\.144\.211\.166/);
  assert.match(deploy, /deploy-finance-vps\.sh/);
  assert.match(deploy, /FPS Finance: productie-release GEFAALD/);
  assert.doesNotMatch(deploy, /noodfix_reden/);
});