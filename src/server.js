// Local dev server. On Vercel, api/index.js serves the API and /public is served as static files.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { app } from "./app.js";

const local = express();
local.use(express.static(path.resolve("public")));
local.use(app);
const port = Number(process.env.PORT) || 3000;
local.listen(port, () => console.log(`Proxy Hearts on http://localhost:${port}`));
