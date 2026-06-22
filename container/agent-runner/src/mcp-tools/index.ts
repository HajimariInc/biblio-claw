/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './biblio.js';
import { startMcpServer } from './server.js';
import { log } from '../log.js';

startMcpServer().catch((err) => {
  log.error('MCP server error', { err });
  process.exit(1);
});
