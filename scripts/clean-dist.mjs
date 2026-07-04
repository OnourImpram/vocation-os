#!/usr/bin/env node
import { rmSync } from "node:fs";
import path from "node:path";

const dist = path.join(process.cwd(), "dist");
rmSync(dist, { recursive: true, force: true });
