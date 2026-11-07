// Inert, reduced protocol fixture. Variable names intentionally differ from the observed bundle.
var currentDeviceIdentity = "fixtureRutubePublicClientId012345678901234";
var unrelatedIdentity = "wrongIdentity01234567890123456789";
var tv = {
  code: function(name) { return post(base + "/device/code/", {client_id:currentDeviceIdentity,device_name:name}); },
  token: function(code) { return post(base + "/device/token", {device_code:code,client_id:currentDeviceIdentity,grant_type:"device_code"}); }
};
