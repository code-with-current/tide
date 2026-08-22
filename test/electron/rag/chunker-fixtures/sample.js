// JS fixture — uses CommonJS + function expressions.
const fs = require('fs');

function greet(name) {
  return `hello ${name}`;
}

class Greeter {
  constructor(prefix) {
    this.prefix = prefix;
  }
  greet(name) {
    return `${this.prefix} ${name}`;
  }
}

module.exports = { greet, Greeter };
