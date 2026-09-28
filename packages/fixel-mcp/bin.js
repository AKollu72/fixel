#!/usr/bin/env node
'use strict';
// Thin launcher: resolves and runs fixel's MCP server entry point.
// Nothing is written to stdout before this require — JSON-RPC over
// stdin/stdout starts the moment fixel's server initialises.
require('fixel/fixel-mcp-bin.js');
