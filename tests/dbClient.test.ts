import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { ensureAgentFsRootPath } from "@/lib/db/client";

let tempRoot = "";

before(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hunterclaw-db-client-"));
});

after(async () => {
  if (tempRoot) {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureAgentFsRootPath creates roots inside the project", () => {
  const projectRoot = path.join(tempRoot, "project-root");
  const nestedRoot = path.join(projectRoot, "sandbox", "nested");

  ensureAgentFsRootPath(nestedRoot, projectRoot);

  assert.equal(fs.existsSync(nestedRoot), true);
  assert.equal(fs.statSync(nestedRoot).isDirectory(), true);
});

test("ensureAgentFsRootPath rejects missing roots outside the project", () => {
  const projectRoot = path.join(tempRoot, "project-root-missing");
  const externalRoot = path.join(tempRoot, "external-root-missing");

  assert.throws(
    () => ensureAgentFsRootPath(externalRoot, projectRoot),
    /must point to an existing directory when outside the project root/,
  );
});

test("ensureAgentFsRootPath accepts existing roots outside the project", async () => {
  const projectRoot = path.join(tempRoot, "project-root-existing");
  const externalRoot = path.join(tempRoot, "external-root-existing");
  await fsPromises.mkdir(externalRoot, { recursive: true });

  assert.doesNotThrow(() => ensureAgentFsRootPath(externalRoot, projectRoot));
});
