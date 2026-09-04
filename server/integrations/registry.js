const sylla = require("./sylla");

// The provider registry.
//
// One entry today. It is a registry rather than a direct require so that
// adding a provider is adding a line here plus one file implementing the
// Connector interface in connector.js - nothing else in klndr changes, because
// nothing else names a provider.
//
// When this eventually becomes a real plugin system, this map is what gets
// populated from somewhere else. The shape it hands out stays the same.
const CONNECTORS = [sylla];

const byId = new Map(CONNECTORS.map((connector) => [connector.id, connector]));

function getConnector(providerId) {
  return byId.get(providerId) || null;
}

/** What the integrations UI lists, without exposing the connectors themselves. */
function listProviders() {
  return CONNECTORS.map((connector) => ({
    id: connector.id,
    label: connector.label,
    icon: connector.icon,
    scopes: connector.scopes,
    configured: connector.isConfigured(),
  }));
}

module.exports = { getConnector, listProviders };
