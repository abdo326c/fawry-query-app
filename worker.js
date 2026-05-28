importScripts('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js');

self.onmessage = function(e) {
    const { fileData, type } = e.data;
    
    if (type === 'csv') {
        Papa.parse(fileData, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                self.postMessage({ status: 'done', data: results.data });
            },
            error: function(err) {
                self.postMessage({ status: 'error', error: err.message });
            }
        });
    }
};
