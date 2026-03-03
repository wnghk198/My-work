(function(){
  if (!Object.fromEntries) {
    Object.fromEntries = function(entries) {
      var obj = {};
      if (!entries) return obj;
      for (var i = 0; i < entries.length; i++) {
        var pair = entries[i] || [];
        obj[pair[0]] = pair[1];
      }
      return obj;
    };
  }
  if (!Number.isFinite) {
    Number.isFinite = function(value) { return typeof value === 'number' && isFinite(value); };
  }
  if (!Array.from) {
    Array.from = function(value) { return Array.prototype.slice.call(value); };
  }
  if (!String.prototype.padStart) {
    String.prototype.padStart = function(targetLength, padString) {
      var str = String(this);
      targetLength = targetLength >> 0;
      padString = String(typeof padString !== 'undefined' ? padString : ' ');
      if (str.length >= targetLength) return str;
      targetLength = targetLength - str.length;
      while (padString.length < targetLength) padString += padString;
      return padString.slice(0, targetLength) + str;
    };
  }
})();
