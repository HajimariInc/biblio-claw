// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// biblio-claw: claude provider needs host-side env passthrough for the
// OneCLI-MITM Vertex path (dummy ANTHROPIC_AUTH_TOKEN + Vertex env group).
import './claude.js';
