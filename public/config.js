// The client build replaces these public addresses. Never put secrets here.
export const config = Object.freeze({ apiBaseUrl: '', wsUrl: '', adminUrl: '/admin' });
export const apiUrl = path => `${config.apiBaseUrl}${path}`;
export const websocketUrl = () => config.wsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
