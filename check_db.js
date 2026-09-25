const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const config = fs.readFileSync('supabase.js', 'utf8');
const urlMatch = config.match(/supabaseUrl\s*=\s*['"]([^'"]+)['"]/);
const keyMatch = config.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/);

if (!urlMatch || !keyMatch) {
    console.log("Could not find supabase credentials");
    process.exit(1);
}

const supabase = createClient(urlMatch[1], keyMatch[1]);

async function checkData() {
    const { data: tx, error: err1 } = await supabase.from('transactions').select('*').eq('reference_number', '9678735915').single();
    console.log("Transaction:", tx);
    
    const { data: mapping, error: err2 } = await supabase.from('item_mappings').select('*').ilike('item_name', '%Spring 26 Fees%');
    console.log("Mappings:", mapping);
}
checkData();
