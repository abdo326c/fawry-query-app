const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// Templates
code = code.replace(
    '"Mapping": ""\n            }]);', 
    '"Mapping": "",\n                "2nd Mapping": ""\n            }]);'
);
code = code.replace(
    '"Mapping": ""\n            }]);', 
    '"Mapping": "",\n                "2nd Mapping": ""\n            }]);'
);

// Exports
code = code.replace(
    '"Mapping": m.mapping || ""\n                }));',
    '"Mapping": m.mapping || "",\n                    "2nd Mapping": m.second_mapping || ""\n                }));'
);
code = code.replace(
    '"Mapping": f.mapping || ""\n                }));',
    '"Mapping": f.mapping || "",\n                    "2nd Mapping": f.second_mapping || ""\n                }));'
);

fs.writeFileSync('app.js', code);
console.log('Templates & Exports updated!');
