const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const firebaseApp = require('firebase/app');
const firebaseFirestore = require('firebase/firestore');
const firebaseStorage = require('firebase/storage');
const fetch = require('cross-fetch');
require('dotenv').config();
const qrcode = require('qrcode-terminal');

// Then, when you need to use functions or variables, destructure them from the required module:
const { initializeApp } = firebaseApp;
const { collection, addDoc, getDocs,setDoc, updateDoc, getFirestore, where, orderBy,limit,query, serverTimestamp, arrayUnion , doc} = firebaseFirestore;
const { getStorage, ref, uploadString, getDownloadURL } = firebaseStorage;

const api_key = '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';
const promptQuestion = `Generate a response in JSON format containing the following information: If the following text has location, description of the apartment, price and availability date. If not, return null object like in javascript. For instance, Location should be a city name, village, county or town. Description may look something like what the apartment look like,for instance: squares meters, number of rooms, toilets, etc. Otherise return a json object with those columns mentioned before. Resolve the country field based on the phone number (eg. if starts with 54 is Argentina, if it starts with 353 is Ireland) or location .Only return the json object with fields in camel case as country, location, description, price, availability date, isLooking. keys should be enclosed in double quotes and you must return only a json object for example { \"field1\": \"value\" }' If the message is saying something like \"I'm looking for\" or \"estoy buscando\" or something similar then return an extra variable in the json object called \"isLooking\" with values true or false.`;

const firebaseConfig = {
    apiKey: process.env.PUBLIC_API_KEY,
    authDomain: process.env.PUBLIC_AUTH_DOMAIN,
    projectId: process.env.PUBLIC_PROJECT_ID,
    storageBucket: process.env.PUBLIC_STORAGE_BUCKET,
    messagingSenderId: process.env.PUBLIC_MESSAGING_SENDER_ID,
    appId: process.env.PUBLIC_APP_ID,
    measurementId: process.env.PUBLIC_MEASUREMENT_ID
};

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

// Initialize Firebase
const app = initializeApp(firebaseConfig);


// Initialize Cloud Firestore and get a reference to the service
const db = getFirestore(app);
// Initialize Cloud Storage and get a reference to the service
const storage = getStorage(app);

// Path where the session data will be stored
const authFile = './auth_info.json';

let authData = null;
if (fs.existsSync(authFile)) {
    console.log(authFile)
    authData = JSON.parse(fs.readFileSync(authFile));
} else {
    authData = {};
}


// Use the saved values
const client = new Client({
    session: authData,
    authTimeoutMs: 5 * 60 * 1000,
    restartOnAuthFail: true,
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-extensions',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- this one doesn't works in Windows
            '--disable-gpu'
        ]
    },
    // Use the local authentication strategy
    authStrategy: new LocalAuth({
        // Path to the authentication file
        authFile
    })
});

client.on('qr', qr => {
    console.log(qr);

    qrcode.generate(qr, { small: true });
    console.log(qr);

});

// Save session values to the file upon successful auth
client.on('authenticated', (session) => {
    console.log('Authenticated!');
    console.log(session);
    // authData = session;
    // fs.writeFile(authFile, JSON.stringify(session), function (err) {
    //     if (err) {
    //         console.error(err);
    //     }
    // });
});


client.on('auth_failure', msg => {
    // Fired if session restore was unsuccessful
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', async () => {
    console.log('Client is ready!');

});

client.on('message', async (msg) => {
    console.log(msg.from);

   if (msg.from === 'status@broadcast' || /@c/.test(msg.from)) return;
    
    console.log(msg);
    //await addDoc(collection(db, 'rawmessages'), JSON.parse(JSON.stringify(msg)));

    const collectionName = 'preAdverts';
    const phoneNumber = msg?.author ? msg?.author : parseWhatsAppId(msg?.from);
    let docRefId = null;
    let media = null;
    let chatGptResponse = { phoneNumber };

    console.log(msg.hasMedia);
    if (msg.hasMedia) {
        try {
            media = await msg.downloadMedia();
            docRefId = await fileUpload(media);
            chatGptResponse.media = { url: docRefId, mimetype: media.mimetype };
        } catch (error) {
            logError(error);
            console.error("Error downloading media: ", error);
            // Handle the error or continue processing other parts of the message
        }
    }

    chatGptResponse.timestamp = msg?.timestamp;
    chatGptResponse.country = msg?.country;

    if (msg.body) {
        chatGptResponse.originalMsg = msg.body;
        const prompt = `${promptQuestion} ${msg.body}`;
        try {
            const response = await fetchOpenAiApi(prompt);
            if (response) {
               // const cleanedText = cleanJsonString(response.choices[0].text);
                const parsedText = JSON.parse(response.response);
                Object.assign(chatGptResponse, parsedText);
                console.log(chatGptResponse)

            }
        } catch (error) {
            logError(error);
            console.error("Error fetching data from API endpoint: ", error);
        }

        // chatGptResponse = {
        //     phoneNumber: '353838454183@c.us',
        //     timestamp: msg?.timestamp,
        //     country: 'Argentina',
        //     originalMsg: '*Featured property of the week at House and Flats!*🔥\n' +
        //       'Modern and bright apartment in Villa Crespo, a few blocks from Plaza Serrano with Patio🍃 \n' +    
        //       'Available🗓️\n'  +
        //       'Monthly price: 820 $USD\n' +
        //       '\n' +
        //       'Secure your extended stays in the city through our platform 🏠✨ \n' +
        //       ' *Book rooms or apartments with monthly stays*🌎💼\n' +
        //       '✅ Automatic reservations and payment methods tailored for foreigners.\n' +
        //       '✅ Personalized assistance.\n' +
        //       '✅ Save time and rent with security in your favorite destinations.\n' +
        //       '✅ Enjoy our benefits, such as included transportation upon arrival at the airport and discounts at' +
        //       ' www.houseandflats.com',
        //     location: 'Villa Crespo',
        //     description: 'Modern and bright apartment with patio located a few blocks from Plaza Serrano.',       
        //     price: 820,
        //     availabilityDate: 'available',
        //     isLooking: true
        //   }
    }

    try {
        await updateOrCreateDocument(collectionName, chatGptResponse);
        console.log("Document successfully updated/created!");
    } catch (error) {
        logError(error);
        console.error("Error updating/creating document: ", error);
    }
});

async function fetchOpenAiApi(prompt) {
    const response = await fetch('http://localhost:8080/api/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: "llama2",
            prompt: prompt,
            stream: false,
            format: "json"
          })
    });
    console.log(response)

    if (!response.ok) {
        throw new Error('Failed to fetch from OpenAI API');
    }
    let r = await response.json();
    console.log(r);

    return r;
}




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
    const storageRef = ref(storage, `${path}/${fileName}`);

    try {
        await uploadString(storageRef, `data:text/plain;base64,${media.data}`, 'data_url');
    } catch (error) {
        logError(error);
        console.error("Error:", error);
        throw error; // re-throw the error so that it can be handled by the calling function
    }

    const downloadURL = await getDownloadURL(storageRef);
    return downloadURL;
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
        const index = timestamp.charAt(timestamp.length - 1);
        name += characters.charAt(index);
        timestamp = Math.floor(timestamp / characters.length).toString();
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

async function updateOrCreateDocument(collectionName, chatGptResponse) {
    const collectionRef = collection(db, collectionName);
    const phoneNumberQuery = query(collectionRef, where("phoneNumber", "==", chatGptResponse.phoneNumber),
    orderBy("timestamp", "desc"), // Order by timestamp in descending order
    limit(1) // Limit to the newest record);
    );
    const querySnapshot = await getDocs(phoneNumberQuery);
    
    let documentToUpdate = null;
    querySnapshot.forEach(doc => {
        const data = doc.data();
        console.log(chatGptResponse.timestamp);
        console.log(data.timestamp);
        console.log(chatGptResponse.timestamp - data.timestamp);
        // Assuming chatGptResponse.timestamp and data.timestamp are Unix timestamps in milliseconds
        if (Math.abs(chatGptResponse.timestamp - data.timestamp) < 15) { // 30 seconds difference
            documentToUpdate = doc;
        }
    });



    if (documentToUpdate) {
        // Update the existing document
        const docRef = doc(db, collectionName, documentToUpdate.id);
        // Use buildUpdateObject to prepare the document data
        const updateData = buildUpdateObject(chatGptResponse);
        await updateDoc(docRef, updateData);
    } else {
        // Use buildUpdateObject to prepare the document data
        const updateData = buildUpdateObject(chatGptResponse);
        // Create a new document
        await addDoc(collectionRef, updateData);
    }

  
    
}

function buildUpdateObject(chatGptResponse) {
    const fields = ["phoneNumber", "location", "timestamp", "description", 
                    "availabilityDate", "price", "country", "media", "isLooking"];
    const updateObj = {};

    fields.forEach(field => {
        if (chatGptResponse[field]) {
            if (field === "media" || field === "isLooking") {
                updateObj[field] = arrayUnion(chatGptResponse[field]);
            } else {
                updateObj[field] = chatGptResponse[field];
            }
        }
    });

    return updateObj;
}

async function logError(error) {
    const collectionRef = collection(db, "errors");
    await addDoc(collectionRef, { error: JSON.stringify(error, Object.getOwnPropertyNames(error)) });
}



client.initialize();