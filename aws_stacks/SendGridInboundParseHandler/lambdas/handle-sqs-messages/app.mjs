/**
 * handle-sqs-messages
 * 
 * Lambda function that is triggered by SQS. Opens message, pulls out
 * payload depending on where the message originated (SQS or Lambda-S3-to-SQS),
 * processes email, save attachments if any, publishes message to SNS topic
 * for downstream processing.
 * 
 */

// Bring in S3 client
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
const s3Client = new S3Client( { region: process.env.REGION } );

import multipart from 'parse-multipart-data'; // Used to parse email file
import { Readable } from 'stream';  // Needed for Upload (@aws-sdk/lib-storage)
import { Upload } from "@aws-sdk/lib-storage"; // Used to upload large files

// Bring in SNS client
import  { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
const snsClient = new SNSClient({ region: process.env.REGION });

/**
 * processEmail gets messageId (from SNS), timestamp, emailContents, boundary
 * (used to parse emailsContents). Accepts a single record from the SQS queue.
 */

async function processEmail(eventSource, messageId, messageTimeStamp, emailContents, boundary) {    
    
    // messageId used to store the email contents and any attacments to S3
    // Pull out a certain files to include in the snsMessage
    let emailObject = {
        messageId:messageId,
        messageTimeStamp:parseInt(messageTimeStamp),        
        snsObject: {
            messageId:messageId,
            messageTimeStamp:parseInt(messageTimeStamp)
        }
    };

    let emailToParse = null;

    if (eventSource === 's3') {
        
        /**
         * Email contents sent as base 64 encode string. Buffer using
         * that specified encoding.
         */
        emailToParse = Buffer.from(emailContents, 'base64');  
    
    } else {
        emailToParse = Buffer.from(emailContents);  
    }
        
    // Parse the contents of form data into an array using multipart node library
    const emailParts = await multipart.parse(emailToParse, boundary);

    // Use map to asynchronously loop through every element of parts array
    let processParts = emailParts.map(async (part) => {
        
        if(part.name !== undefined && part.data !== undefined) {
            
            if (part.filename !== undefined) {
                // THIS IS AN ATTACHMENT!
                // SAVE TO S3

                let bucket = process.env.SENDGRID_INBOUND_PARSE_BUCKET;
                let key = `${messageId}/${part.filename}`;
                
                // Create a buffer from the binary buffer from parse
                let attachmentBuffer = Buffer.from(part.data, "binary");
                
                // Create a readable stream to put file into S3 using "Upload"
                let attachmentStream = Readable.from(attachmentBuffer);                  

                try {
                    let parallelUploads3 = new Upload({
                      client: s3Client,
                      params: { 
                        Bucket:bucket, 
                        Key:key, 
                        Body: attachmentStream,
                        ContentType: part.type
                      }          
                    });
                  
                    parallelUploads3.on("httpUploadProgress", (progress) => {
                      console.log(progress);
                    });
                  
                    await parallelUploads3.done();

                  } catch (e) {

                    console.log("Error loading attachment file into S3 => ", e);

                  }
                                       
            } else {                        
                
                // NOT ATTACHMENT, PARSE THE DATA OUT AND PUT INTO OBJECT save to S3
                let name = part.name.toLowerCase();

                // Pull out string from buffer
                let dataString = Buffer.from(part.data).toString();

                // Handle the "headers" element differently
                // Expand each of them so they can be view separately
                if (name == "headers") {
                    
                    emailObject["headers"] = {};
                    let headerLines = dataString.split('\n');                    
                    const processHeaders = headerLines.map(async (header) => {
                        let h = header.split('\:');
                        if (h.length>1 && h[0] !== '' && h[0] !== undefined && h[1] !== undefined ) {
                            let header = h[0].replaceAll("\'","").trim();
                            let value = h[1].replaceAll("\'","").trim();
                            emailObject["headers"][header] = value;
                        }    
                    });
                    await Promise.all(processHeaders);

                } else {
                                    
                    // Pull out specific key values to include in SNS message
                    // Keeps the size of the SNS message low (include what you need)                    
                    if (["to", "from", "subject", "attachments"].includes(name)) {
                        emailObject.snsObject[name] = dataString;
                    }
                    
                    // Put every element into the parent object to be saved to S3
                    emailObject[name] = dataString;

                }
            }

        }        

    });
    
    // Wait for everything to process...
    await Promise.all(processParts);

    return emailObject;
}

/**
 * Every email is saved to S3. This function saves a json
 * object email.json
 */
async function saveToS3(emailObject) {
    
    // Object to save to S3
    let params = {
        Bucket: process.env.SENDGRID_INBOUND_PARSE_BUCKET,
        Key: `${emailObject.messageId}/email.json`,
        Body: JSON.stringify(emailObject),
        ContentType: 'application/json'        
    };    
    
    // Send to S3
    try {            
        
        await s3Client.send(new PutObjectCommand(params));                

    } catch (err) {
        
        console.log("Error saving email object to S3!", err.stack);

    }         
    
    return true;

}

/**
 * Publish a smaller set of parameters to SNS for
 * additional processing. The messageId can be used 
 * to access email.json file with ALL details plus
 * an file attachments.
 */
async function publishToSNS(snsObject) {
    
    // Object to send to SNS
    let params = {
        Message: JSON.stringify(snsObject),            
        TopicArn: process.env.SNStopic
    };
    
    // Send to SNS
    try {            
        
        await snsClient.send(new PublishCommand(params));                

    } catch (err) {
        
        console.log("Error publishing message to Topic!", err.stack);

    }         
    
    return true;

}

export const lambdaHandler = async (event, context) => {
    
    console.log(JSON.stringify(event, 2, null));        

    // Loop through all messages in batch received from SQS
    // Number of messages pulled from each poll to SQS is
    // configurable. Map through the array.
    
    await Promise.all(event.Records.map(async (record) => {

        // Initialize / set the necessary parameters
        let messageId = record.messageId; // This is the id from the SQS         
        let messageTimeStamp = (record.attributes['ApproximateFirstReceiveTimestamp']) ? (record.attributes['ApproximateFirstReceiveTimestamp']) : null;

        const isValidJSON = obj => {
            try {
              JSON.parse(obj);
              return true;
            } catch (e) {
              return false;
            }
          };
        let bodyIsJson = isValidJSON(record?.body);

        let emailContents = null; // Placeholder for email contents
        let boundary = null; // Placeholder for boundary used to parse emailContents

        let eventSource = null;

        /**
         * Messages from SQS are received from either the API => SQS flow
         * or from the API => Lambda => S3 => SQS flow. The message content
         * will be different depending on source. Test for source and process
         * message content accordingly.
         */

        // HANDLE S3 Case First

        // Check if this message came from API => LAMBDA => S3 => SQS
        // API => LAMBDA => S3 => SQS will return json object return from S3 event,
        // API => SQS returns the body of the post request as the body (not json)
        //if (sqsMessageBody?.Records !== undefined && sqsMessageBody.Records[0].eventSource !== undefined && sqsMessageBody.Records[0].eventSource === "aws:s3") {
        if (bodyIsJson) {

            eventSource = "s3";

            let sqsMessageBody = JSON.parse(record?.body);

            if (sqsMessageBody.Event !== undefined && sqsMessageBody.Event === "s3:TestEvent") {
                // Catching test event triggered when SQS queue initially 
                // connects to this lambda.
                console.log("Test event caught.");
                return;
            }

            // Get the bucket and key for object storing this set of events
            let bucket = sqsMessageBody?.Records[0]?.s3.bucket.name;
            let key = decodeURIComponent(sqsMessageBody?.Records[0]?.s3.object.key);

            // Pull out the boundary from the S3 object key. In the 
            // inbound-email-to-s3 lambda, this is pulled from the request
            // header and added to the object key so it can be extracted
            // in this step.
            boundary = key.replace(/^.*boundary-/,"").replace(/-email.b64/,"");

            //console.log("bucket => ", bucket);
            //console.log("key => ", key);
            //console.log("bounary => ", boundary);
                        
            let command = new GetObjectCommand({Bucket: bucket,Key: key});
            
            try {
        
                // Get the Object from S3
                let data = await s3Client.send(command);        
                
                // The object is string saved with Base64 encoding                            
                emailContents = await data.Body.transformToString();

                //console.log ("From Lambda > S3 and emailContents are (base64 encoding) => ", emailContents);
    
            } catch (error) {
        
                console.log("Error getting object from S3! => ", error);
        
            }            

        } else {

            // Message is from API => SQS => LAMBDA    

            eventSource = "sqs";

            // Configure authentication, pull username and
            // password entered in SG to secure this webhook.
            // Because request went straigt to SQS so needs
            // to be checked before proceeding.
            const authUser = process.env.INBOUND_PARSE_USER;
            const authPass = process.env.INBOUND_PARSE_PASSWORD;

            // Construct the Basic Auth string expected
            const authString = 'Basic ' + Buffer.from(authUser + ':' + authPass).toString('base64');

            //console.log("Calculated authString => ", authString);
            //console.log("event.Records[0].messageAttributes.authorization.stringValue => ", event.Records[0].messageAttributes.authorization.stringValue);
            
            // Check BASIC AUTHENTHICATION was passed in with the request AND matches values in environment variables.
            if (event.Records[0].messageAttributes.authorization !== undefined && event.Records[0].messageAttributes.authorization.stringValue && event.Records[0].messageAttributes.authorization.stringValue === authString) {

                // Prepare inbound email contents to be parsed
                // let body = Buffer.from(event.Records[0].body);    
                // It should just be a string ath this point...

                emailContents = event.Records[0].body;

                // get boundary for multipart data e.g. ------WebKitFormBoundaryDtbT5UpPj83kllfw
                // boundary set from request header when loading into SQS from API
                boundary = multipart.getBoundary(event.Records[0].messageAttributes.contentType.stringValue);
                
                //console.log("boundary => ", boundary);

            } else {

                // HANDLE FAILED CHECK OF AUTHORIZATION HEADER
                // Send notification or alarm...

                console.log("!!!!!!!!!!! Basic Authentication FAILED !!!!!!!!!!!");   

                return;

            }
        }

        if (emailContents !== null) {
            
            let emailObject = await processEmail(eventSource,messageId,messageTimeStamp,emailContents,boundary);

            //console.log("emailObject post process => ", emailObject);
            
            // Save entire Object to S3 (any file attachments saved separately)
            await saveToS3(emailObject);

            // Send emailObject.snsObject to SNS for additional processing
            await publishToSNS(emailObject.snsObject);
        
        }

    }));            

};