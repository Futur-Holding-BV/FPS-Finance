import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function read(relativePath) {
  return readFile(path.join(artifactRoot, relativePath), "utf8");
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
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
    'sudo systemctl stop "\\${PROVISION_SERVICE_NAME}"',
    "sudo install -o root -g root -m 0600",
    "sudo systemctl start \\${PROVISION_SERVICE_NAME}",
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
  assert.doesNotMatch(script, /source "\$\{REMOTE_RUNTIME_ENV_FILE\}"/);
  assert.match(script, /FINANCE_DATABASE_URL="\$\{FINANCE_RUNTIME_DATABASE_URL\}"/);
  assert.match(script, /grep -Fxq "\\\$\{RELEASE_TAG\}"/);
  assert.doesNotMatch(script, /grep -Fxq '\\\$\{RELEASE_TAG\}'/);
  assert.match(script, /fps-finance-deploy\.lock/);
  assert.match(script, /AUTO_CUTOVER_LEGACY_DATABASE_ROLES/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore --list/);
  assert.match(
    script,
    /chmod o\+rx '\$\{DEPLOY_DIR\}' '\$\{DEPLOY_DIR\}\/releases' '\$\{DEPLOY_DIR\}\/releases\/\$\{RELEASE_TAG\}'/,
  );
  assert.match(script, /finance-role-cutover/);
  assert.match(script, /\/run\/fps-finance\/provision\.env/);
  assert.match(script, /sudo rm -f \/etc\/fps-finance\/env/);
  assert.match(script, /public_result=.*curl -sS --location/s);
  assert.match(script, /--proto-redir '=https'/);
  assert.match(script, /public_code.*== "200"/s);
  assert.match(script, /<title>FPS Finance<\/title>/);
  assert.match(script, /<div id="root"><\/div>/);
});

test("SYNC_REMOTE_ENV validates every required production value without logging secrets", async (t) => {
  const validatorPath = path.join(artifactRoot, "dist/validate-production-config.mjs");
  await access(validatorPath);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fps-finance-deploy-fixture-"));
  const fixtureBin = path.join(fixtureRoot, "bin");
  await mkdir(fixtureBin, { recursive: true });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await Promise.all([
    writeExecutable(
      path.join(fixtureBin, "pnpm"),
      "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
    ),
    writeExecutable(
      path.join(fixtureBin, "rsync"),
      "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
    ),
    writeExecutable(
      path.join(fixtureBin, "ssh"),
      `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "\${args}" == *"curl -sS -o /dev/null -w"* ]]; then
  printf '200'
  exit 0
fi
if [[ "\${args}" == *"bash -s"* ]]; then
  cat >/dev/null
fi
`,
    ),
    writeExecutable(
      path.join(fixtureBin, "tar"),
      `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for ((index = 0; index < \${#args[@]}; index += 1)); do
  if [[ "\${args[index]}" == "-czf" ]]; then
    : > "\${args[index + 1]}"
    exit 0
  fi
done
echo "Unexpected tar invocation" >&2
exit 64
`,
    ),
    writeExecutable(
      path.join(fixtureBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
output_file=""
for ((index = 0; index < \${#args[@]}; index += 1)); do
  if [[ "\${args[index]}" == "-o" ]]; then
    output_file="\${args[index + 1]}"
  fi
done
[[ -n "\${output_file}" ]]
printf '%s' '<!doctype html><title>FPS Finance</title><div id="root"></div>' > "\${output_file}"
printf '200\\thttps://finance.fixture.invalid/'
`,
    ),
  ]);

  const fixtureSecrets = {
    FINANCE_MIGRATION_DATABASE_URL:
      "postgresql://fps_finance_migrator@127.0.0.1:5432/fps_finance",
    FINANCE_RUNTIME_DATABASE_PASSWORD: "runtime-$-fixture-password-12345",
    FINANCE_SESSION_SECRET: "session-$-fixture-secret-with-more-than-32-characters",
    FINANCE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    FINANCE_GRAPH_TENANT_ID: "00000000-0000-4000-8000-000000000001",
    FINANCE_GRAPH_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
    FINANCE_GRAPH_CLIENT_SECRET: "graph-$-fixture-secret-with-spaces allowed",
  };
  const fixtureEnv = {
    PATH: `${fixtureBin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? fixtureRoot,
    LANG: process.env.LANG ?? "C.UTF-8",
    APP_DIR: artifactRoot,
    SSH_USER: "fixture-deployer",
    SSH_HOST: "127.0.0.1",
    REMOTE_HOST: "finance.fixture.invalid",
    HEALTH_RETRIES: "1",
    HEALTH_INTERVAL: "0",
    SYNC_REMOTE_ENV: "true",
    DATABASE_URL: "postgresql://shared@127.0.0.1:5432/shared",
    SESSION_SECRET: "generic-session-secret-must-be-unset",
    ...fixtureSecrets,
  };

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [path.join(artifactRoot, "scripts/deploy-finance-vps.sh")],
    {
      cwd: path.resolve(artifactRoot, "../.."),
      env: fixtureEnv,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  const output = `${stdout}\n${stderr}`;

  assert.match(output, /FPS Finance production configuration is valid\./);
  assert.match(output, /Deployment of fps-finance .* completed successfully\./);
  for (const secretValue of Object.values(fixtureSecrets)) {
    assert.doesNotMatch(output, new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
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