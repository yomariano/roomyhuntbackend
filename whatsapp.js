console.log('Script started');

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg; // Update import to include LocalAuth
import fetch from 'cross-fetch';
import qrcode from 'qrcode-terminal';
import { supabase } from './config.js';
import { exec } from 'child_process';
import util from 'util';
import dotenv from 'dotenv';
import { setTimeout } from 'timers/promises';


dotenv.config(); // Load environment variables from .env file

console.log('Imports completed');

//const promptQuestion = `Generate a valid JSON response containing the following fields: country, location, description, price, availabilityDate, and isLooking. If the field is missing from the input, return null. The message is between <<< and >>>. Please ensure the response is a valid JSON object.
const promptQuestion = `Generate a response in JSON format containing the following information: If the following text has location, description of the apartment, price and availability date. If not, return null object like in javascript. For instance, Location should be a city name, village, county or town. Description may look something like what the apartment look like,for instance: squares meters, number of rooms, toilets, etc. Otherise return a json object with those columns mentioned before. Resolve the country field based on the phone number (eg. if starts with 54 is Argentina, if it starts with 353 is Ireland) or location .Only return the json object with fields in camel case as country, location, description, price, availability date, isLooking. keys should be enclosed in double quotes and you must return only a json object for example { \"field1\": \"value\" }' If the message is saying something like \"I'm looking for\" or \"estoy buscando\" or something similar then return an extra variable in the json object called \"isLooking\" with values true or false.`;


const FILE_TYPES = {
    IMAGE: ['image/jpeg', 'image/png', 'image/gif'],
    VIDEO: ['video/mp4', 'video/quicktime', 'video/webm'],
    DOCUMENT: ['application/pdf', 'application/msword', 'application/vnd.ms-excel']
};

const UPLOAD_PATHS = {
    IMAGE: 'public',
    VIDEO: 'public',
    DOCUMENT: 'public'
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

// Modify the client initialization
async function initializeClient() {
    while (true) {
        try {
            await client.initialize();
            console.log('WhatsApp client initialized successfully');
            return;
        } catch (error) {
            console.error('Failed to initialize WhatsApp client:', error);
            console.log('Retrying in 30 seconds...');
            await setTimeout(3000);
        }
    }
}

// Replace the existing client.initialize() call with:
initializeClient();

// Modify the message event handler
client.on('message', async (msg) => {
    try {
        console.log(msg.from);

        if (msg.from === 'status@broadcast' || /@c/.test(msg.from)) return;

        const phoneNumber = msg?.author ? msg?.author : parseWhatsAppId(msg?.from);
        let chatGptResponse = await getRecentChatGptResponse(phoneNumber);
        console.log("line 164 => ", chatGptResponse);
        if (!chatGptResponse) {
            chatGptResponse = { phoneNumber, media: [] };
        }

        // Update timestamp for each message
        chatGptResponse.timestamp = new Date(msg?.timestamp * 1000).toISOString();
        chatGptResponse.country = msg?.country;

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                const mediaURL = await fileUpload(media);
                chatGptResponse.media.push(mediaURL);
            } catch (error) {
                console.error("Error downloading media: ", error);
            }
        }

        if (msg.body) {
            chatGptResponse.originalMsg = msg.body;
            const prompt = `${promptQuestion}${msg.body}`;
            try {
                const response = await fetchOpenAiApi(prompt);
                if (response) {
                    Object.assign(chatGptResponse, response);
                } else {
                    console.log('No response from ChatGPT');
                }
            } catch (error) {
                console.error("Error fetching data from API endpoint: ", error);
            }
        }

        try {
            await upsertDocument(chatGptResponse);
        } catch (error) {
            console.error("Error storing message in preAdvertsJsonb: ", error);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        await logError(error);
    }
});

// Add a disconnected event handler
client.on('disconnected', (reason) => {
    console.log('Client was disconnected', reason);
    initializeClient();
});

// Add more debug logging
process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

const execPromise = util.promisify(exec);

async function fetchOpenAiApi(prompt) {
    console.log('Prompt:', prompt);

    const payload = {
        model: getModel(), // Use the function to get the model
        messages: [
            {
                role: "user",
                content: prompt
            }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "response",
                strict: "true",
                schema: {
                    type: "object",
                    properties: {
                        country: {
                            type: "string"
                        },
                        location: {
                            type: "string"
                        },
                        description: {
                            type: "string"
                        },
                        price: {
                            type: "string"
                        },
                        availabilityDate: {
                            type: "string"
                        },
                        isLooking: {
                            type: "boolean"
                        }
                    },
                    required: ["country", "location", "description", "price", "availabilityDate", "isLooking"]
                }
            }
        },
        temperature: 0.7,
        max_tokens: 500,
        stream: false
    };

    try {
        const response = await fetch(process.env.MODEL_API_URL || "llama-2-7b-function-calling", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API response error:', errorText);
            return null;
        }

        const responseData = await response.json();
        console.log('API response:', responseData);

        if (responseData.choices && responseData.choices.length > 0) {
            const content = responseData.choices[0].message.content;
            console.log('Parsed content:', content);

            try {
                return JSON.parse(content);
            } catch (parseError) {
                console.error('Error parsing content as JSON:', parseError);
                return null;
            }
        } else {
            console.log('No choices in API response');
            return null;
        }

    } catch (error) {
        console.error('Error fetching data from API endpoint:', error);
        await logError(error);
        return null;
    }
}

// Ensure 'fileUpload' is declared only once
const fileUpload = async (media) => {
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
        return null;
    }

    const fileName = media.filename || generateRandomName(new Date().getTime());
    const filePath = `${path}/${fileName}`;

    try {
        const { data, error } = await supabase.storage.from('roomyHuntMedia').upload(filePath, Buffer.from(media.data, 'base64'), {
            contentType: mimeType,
            upsert: true
        });
        
        if (error) {
            console.error("Supabase upload error:", error);
            throw error;
        }
        
        // Get the public URL for the uploaded file
        const { data: { publicUrl }, error: urlError } = supabase
            .storage
            .from('roomyHuntMedia')
            .getPublicUrl(filePath);

        if (urlError) {
            console.error("Error getting public URL:", urlError);
            throw urlError;
        }

        // Return the full public URL
        return publicUrl;
    } catch (error) {
        console.error("Detailed upload error:", error);
        await logError(error);
        return null;
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
    
    let message = {
        phoneNumber,
        timestamp: new Date(timestamp).toISOString(),
        ...otherFields
    };

    // Parse the AI response if it's a string
    if (typeof message.content === 'string') {
        try {
            const parsedContent = JSON.parse(message.content);
            message = { ...message, ...parsedContent };
        } catch (error) {
            console.error("Error parsing AI response:", error);
        }
    }

    try {
        // Fetch the most recent message from this phone number
        const { data: existingData, error: fetchError } = await supabase
            .from('preAdvertsJsonb')
            .select('*')
            .eq('message->>phoneNumber', phoneNumber)
            .order('message->>timestamp', { ascending: false })
            .limit(1)
            .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
            throw fetchError;
        }

        let result;
        if (existingData) {
            const existingTimestamp = new Date(existingData.message.timestamp);
            const incomingTimestamp = new Date(message.timestamp);
            const timeDifference = Math.abs(incomingTimestamp - existingTimestamp);

            if (timeDifference <= 15000) { // 15 seconds in milliseconds
                // If within 15 seconds, update the existing record
                const existingMedia = existingData.message.media || [];
                const newMedia = message.media || [];
                const updatedMedia = [...new Set([...existingMedia, ...newMedia])]; // Remove duplicates

                const updatedMessage = {
                    ...existingData.message,
                    ...message,
                    media: updatedMedia
                };
                const { data, error } = await supabase
                    .from('preAdvertsJsonb')
                    .update({ message: updatedMessage })
                    .eq('id', existingData.id)
                    .select();
                if (error) throw error;
                result = data;
            } else {
                // If more than 15 seconds, insert a new record
                const { data, error } = await supabase
                    .from('preAdvertsJsonb')
                    .insert({ message })
                    .select();
                if (error) throw error;
                result = data;
            }
        } else {
            // If no existing message, insert a new record
            const { data, error } = await supabase
                .from('preAdvertsJsonb')
                .insert({ message })
                .select();
            if (error) throw error;
            result = data;
        }

        console.log("Document successfully upserted:", result);
        return result;
    } catch (error) {
        console.error("Error upserting document: ", error);
        await logError(error);
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

async function getRecentChatGptResponse(phoneNumber) {
    const timeDifference = new Date(Date.now() - 15000).toISOString();
    try {
        const { data, error } = await supabase
            .from('preAdvertsJsonb')
            .select('*')
            .eq('message->>phoneNumber', phoneNumber)
            .gte('message->>timestamp', timeDifference)
            .order('message->>timestamp', { ascending: false })
            .limit(1)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                // No recent message found
                return null;
            }
            throw error;
        }

        return data.message;
    } catch (error) {
        console.error("Error fetching recent ChatGPT response: ", error);
        return null;
    }
}

function getModel() {
    return process.env.AI_MODEL || "llama-2-7b-function-calling";
}

// Add a global error handler
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await logError(error);
});
