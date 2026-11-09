// Test fixture: one line per JS signal

// browser-sinks zone: DOM manipulation
element.innerHTML = html;
element.insertAdjacentHTML('beforeend', html);
const component = <div dangerouslySetInnerHTML={{ __html: html }} />;

// browser-sinks zone: cross-origin
window.postMessage({ data }, '*'); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration Planted wildcard target for the zone scan self test.
const fn = new Function('return ' + code);

// third-party zone: external scripts (in markup context, but for completeness)
// Note: markup patterns are for HTML content
