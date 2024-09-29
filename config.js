import 'dotenv/config' // Ensure environment variables are loaded
import { createClient } from '@supabase/supabase-js'

// Retrieve Supabase URL and Key from environment variables
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.PUBLIC_SUPABASE_ANON_KEY

// Validate that both variables are present
if (!supabaseUrl || !supabaseAnonKey) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in environment variables.')
    process.exit(1) // Exit the application if variables are missing
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)