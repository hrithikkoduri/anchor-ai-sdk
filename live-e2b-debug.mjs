import { Template, defaultBuildLogger } from "e2b";
const name = `anchor-e2b-dbg5`;
const t = Template()
  .fromUbuntuImage("24.04")
  .runCmd([
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends git ca-certificates curl bash coreutils ripgrep",
    "rm -rf /var/lib/apt/lists/*",
    "git --version && timeout --version | head -1",
  ], { user: "root" });
try {
  const info = await Template.build(t, name, { cpuCount: 2, memoryMB: 2048, onBuildLogs: defaultBuildLogger() });
  console.log("built:", JSON.stringify(info));
} catch (e) {
  console.log("BuildError:", e.message, e.logs ? String(e.logs).slice(-600) : "");
}
