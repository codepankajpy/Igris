/** Fixed sink port: the e2e suite always starts the sink here. */
export const SINK_PORT = 38545;

export const ANALYTICS_URL = `http://ingest.igris-analytics.test:${SINK_PORT}/v1/track`;
export const ERRORS_URL = `http://o1.igris-errors.test:${SINK_PORT}/api/1/envelope`;
export const PIXEL_URL = `http://img.igris-cdn.test:${SINK_PORT}/pixel`;
