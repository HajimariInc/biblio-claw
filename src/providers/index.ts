// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers without host
// needs (e.g. mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// biblio-claw: claude needs host-side env passthrough for the OneCLI-MITM
// Vertex path (Vertex env group + dummy ANTHROPIC_AUTH_TOKEN). Upstream
// NanoClaw doesn't import this because its standard install hits
// api.anthropic.com directly; we route through Vertex.
import './claude.js';
