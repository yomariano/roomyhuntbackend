console.log('Script started');

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg; // Update import to include LocalAuth
import fetch from 'cross-fetch';
import qrcode from 'qrcode-terminal';
import { supabase } from './config.js';
import { HfInference } from '@huggingface/inference';
import { exec } from 'child_process';
import util from 'util';



console.log('Imports completed');

//const promptQuestion = `Generate a response in JSON format containing the following information: If the following text has location, description of the apartment, price and availability date. If not, return null object like in javascript. For instance, Location should be a city name, village, county or town. Description may look something like what the apartment look like,for instance: squares meters, number of rooms, toilets, etc. Otherise return a json object with those columns mentioned before. Resolve the country field based on the phone number (eg. if starts with 54 is Argentina, if it starts with 353 is Ireland) or location. Only return the json object with fields in camel case as country, location, description, price, availabilityDate, isLooking. keys should be enclosed in double quotes and you must return only a json object for example { \"field1\": \"value\" }' If the message is saying something like \"I'm looking for\" or \"estoy buscando\" or something similar then return an extra variable in the json object called \"isLooking\" with values true or false. The response should be a valid JSON object`;
const promptQuestion = `Generate a valid JSON response containing the following fields: country, location, description, price, availabilityDate, and isLooking. If the field is missing from the input, return null. The message is between <<< and >>>. Please ensure the response is a valid JSON object.

Message: <<<`;

const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

const FILE_TYPES = {
    IMAGE: ['image/jpeg', 'image/png', 'image/gif'],
    VIDEO: ['video/mp4', 'video/quicktime', 'video/webm'],
    DOCUMENT: ['application/pdf', 'application/msword', 'application/vnd.ms-excel']
};

const UPLOAD_PATHS = {
    IMAGE: 'images',
    VIDEO: 'videos',
    DOCUMENT: 'applications'
};

// Custom Supabase store
class SupabaseStore {
    constructor() {
        console.log('SupabaseStore initialized');
    }

    async sessionExists({ session }) {
        console.log('Checking if session exists:', session);
        try {
            const { data, error } = await supabase
                .from('whatsapp_sessions')
                .select('session_data')
                .eq('session_name', session)
                .single();
            
            if (error) {
                if (error.code === 'PGRST116') {
                    // This error means no rows were found, which is fine
                    console.log('No existing session found');
                    return false;
                }
                // For other errors, we should still throw
                throw error;
            }
            
            console.log('Session exists:', !!data);
            return !!data;
        } catch (error) {
            console.error('Error checking session existence:', error);
            return false;
        }
    }

    async save({ session, data }) {
        console.log('Attempting to save session:', session);
        try {
            console.log('Session data type:', typeof data);
            console.log('Session data length:', data ? JSON.stringify(data).length : 'N/A');
            console.log('Session data content:', data);
            
            // Ensure data is always stored as a string
            const dataToSave = data ? JSON.stringify(data) : '{}';
            
            const { error } = await supabase
                .from('whatsapp_sessions')
                .upsert({ 
                    session_name: session, 
                    session_data: dataToSave 
                }, { onConflict: 'session_name' });

            if (error) throw error;
            console.log('Session saved successfully');
        } catch (error) {
            console.error('Error saving session:', error);
            throw error;
        }
    }
    
    async delete({ session }) {
        console.log('Attempting to delete session:', session);
        try {
            const { error } = await supabase
                .from('whatsapp_sessions')
                .delete()
                .eq('session_name', session);
            if (error) throw error;
            console.log('Session deleted successfully');
        } catch (error) {
            console.error('Error deleting session:', error);
            throw error;
        }
    }

    async destroy() {
        console.log('SupabaseStore destroy method called');
        // Implement any cleanup logic here if needed
    }
}

// Instantiate the SupabaseStore
const store = new SupabaseStore();
console.log('SupabaseStore instantiated');

// Use the saved values
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-extensions',
          '--disable-gpu',
          '--disable-dev-shm-usage'
        ],
        timeout: 60000
      }
});

console.log('WhatsApp client instance created');

client.on('qr', qr => {
    console.log('QR Code received, scan it to authenticate');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Client authenticated');
});

client.on('auth_failure', msg => {
    console.error('Authentication failure:', msg);
});

client.on('ready', () => {
    console.log('Client is ready');
});

client.initialize().then(() => {
    console.log('WhatsApp client initialized successfully');
}).catch(error => {
    console.error('Failed to initialize WhatsApp client:', error);
});

console.log('Client initialization started');

client.on('message', async (msg) => {
    console.log(msg.from);

    if (msg.from === 'status@broadcast' || /@c/.test(msg.from)) return;

    console.log(msg);

    const phoneNumber = msg?.author ? msg?.author : parseWhatsAppId(msg?.from);
    let mediaURL = null;
    let chatGptResponse = { phoneNumber };

    console.log(msg.hasMedia);
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            mediaURL = await fileUpload(media);
            chatGptResponse.media = mediaURL;
        } catch (error) {
            console.error("Error downloading media: ", error);
        }
    }

    chatGptResponse.timestamp = new Date(msg?.timestamp * 1000).toISOString();
    chatGptResponse.country = msg?.country;

    if (msg.body) {
        chatGptResponse.originalMsg = msg.body;
        const prompt = `${promptQuestion}${msg.body}>>>`;
        try {
            const response = await fetchOpenAiApi(prompt);
            if (response) {
                Object.assign(chatGptResponse, response);
                console.log('ChatGPT Response:', chatGptResponse);
            } else {
                console.log('No response from ChatGPT');
            }
        } catch (error) {
            console.error("Error fetching data from API endpoint: ", error);
        }
    }

    try {
        await upsertDocument(chatGptResponse);
        console.log("Message successfully stored in preAdvertsJsonb");
    } catch (error) {
        console.error("Error storing message in preAdvertsJsonb: ", error);
    }
});

// Add more debug logging
process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
    client.destroy();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    client.destroy();
    process.exit(0);
  });

const execPromise = util.promisify(exec);

async function fetchOpenAiApi(prompt) {
    console.log('Prompt:', prompt);

    const curlCommand = `curl -X POST http://localhost:1234/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
      "model": "Trelis/Llama-2-7b-chat-hf-function-calling-v2/llama-2-7b-function-calling.Q3_K_M.gguf",
      "messages": [
        {
          "role": "user",
          "content": ${JSON.stringify(prompt)}
        }
      ],
      "temperature": 0.7,
      "max_tokens": 500
    }'`;

    try {
        const { stdout, stderr } = await execPromise(curlCommand);
        
        if (stderr) {
            console.error('Curl command error:', stderr);
        }

        console.log('Raw API response:', stdout);

        const response = JSON.parse(stdout);
        const content = response.choices[0].message.content;

        console.log('Parsed content:', content);

        // Attempt to parse the content as JSON
        try {
            const parsedContent = JSON.parse(content);
            return parsedContent;
        } catch (parseError) {
            console.error('Error parsing content as JSON:', parseError);
            return null;
        }
    } catch (error) {
        console.error('Error executing curl command:', error);
        throw error;
    }
}

// Ensure 'fileUpload' is declared only once
const fileUpload = async (media) => {
    console.log(media?.mimetype);
    let path = '';

    const mimeType = media?.mimetype;

    if (FILE_TYPES.IMAGE.includes(mimeType)) {
        path = UPLOAD_PATHS.IMAGE;
    } else if (FILE_TYPES.VIDEO.includes(mimeType)) {
        path = UPLOAD_PATHS.VIDEO;
    } else if (FILE_TYPES.DOCUMENT.includes(mimeType)) {
        path = UPLOAD_PATHS.DOCUMENT;
    } else {
        console.error("Unsupported file type.");
        return;
    }

    const fileName = media.filename || generateRandomName(new Date().getTime());
    const filePath = `${path}/${fileName}`;

    try {
        const { data, error } = await supabase.storage.from('roomyHuntMedia').upload(filePath, Buffer.from(media.data, 'base64'), {
            contentType: mimeType,
            upsert: true
        });
        if (error) {
            throw error;
        }
        const { publicURL, error: urlError } = supabase.storage.from('roomyHuntMedia').getPublicUrl(filePath);
        if (urlError) {
            throw urlError;
        }
        return publicURL;
    } catch (error) {
        logError(error);
        console.error("Error uploading file: ", error);
        throw error; // re-throw the error so that it can be handled by the calling function
    }
}


function parseWhatsAppId(whatsAppId) {
    const regex = /^(\d+)@c\.us$/;
    const match = regex.exec(whatsAppId);
    if (match) {
        return match[1]; // the phone number as a string
    } else {
        return null; // invalid format
    }
}

function generateRandomName(seed) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let name = "";
    let timestamp = seed.toString();

    while (name.length < 10) {
        const index = parseInt(timestamp.charAt(timestamp.length - 1)) % characters.length;
        name += characters.charAt(index);
        timestamp = Math.floor(parseInt(timestamp) / characters.length).toString();
    }

    return name;
}


function isNullOrEmpty(obj) {
    return typeof obj === "undefined" || obj === null || Object.keys(obj).length === 0;
}

function cleanJsonString(jsonString) {
    const cleanedString = jsonString.trim().replace(/^[^\{]+/, '').replace(/[^\}]+$/, '');
    return cleanedString;
}

async function upsertDocument(chatGptResponse) {
    const { phoneNumber, timestamp, ...otherFields } = chatGptResponse;
    
    const message = {
        phoneNumber,
        timestamp: new Date(timestamp).toISOString(),
        ...otherFields
    };

    try {
        const { data, error } = await supabase
            .from('preAdvertsJsonb')
            .insert({ message })
            .select();

        if (error) throw error;
        console.log("Document successfully inserted:", data);
        return data;
    } catch (error) {
        console.error("Error inserting document: ", error);
        throw error;
    }
}

async function getRecentMessages(limit = 10) {
    try {
        const { data, error } = await supabase
            .from('preAdvertsJsonb')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data;
    } catch (error) {
        console.error("Error fetching recent messages: ", error);
        throw error;
    }
}

async function searchMessages(searchTerm) {
    try {
        const { data, error } = await supabase
            .from('preAdvertsJsonb')
            .select('*')
            .filter('message->>originalMsg', 'ilike', `%${searchTerm}%`);

        if (error) throw error;
        return data;
    } catch (error) {
        console.error("Error searching messages: ", error);
        throw error;
    }
}

async function logError(error) {
    const { data, error: insertError } = await supabase.from("errors").insert([
        { error: error.message || JSON.stringify(error, Object.getOwnPropertyNames(error)) }
    ]);
    if (insertError) {
        console.error("Failed to log error:", insertError);
    }
}