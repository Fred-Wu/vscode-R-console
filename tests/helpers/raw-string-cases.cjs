// Cover R's delimiter grammar, not just the originally reported dash example.
const cases = [];
for (const prefix of ["r", "R"]) {
  for (const quote of ['"', "'"]) {
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      for (const dashes of ["", "-", "--", "-----"]) {
        const wrongClose = close === ")" ? "]" : ")";
        const otherQuote = quote === '"' ? "'" : '"';
        const content = `first ${dashes}${quote}\n# literal comment\n!@$%^&*_=+|:;,./? \\ \`\n${wrongClose}${dashes}${quote}\n${close}${dashes}${otherQuote}\n${close}${dashes}-${quote}\nlast`;
        const opening = `${prefix}${quote}${dashes}${open}`;
        const closing = `${close}${dashes}${quote}`;
        cases.push({ literal: opening + content + closing, incomplete: opening + content, content });
      }
    }
  }
}
module.exports = cases;
