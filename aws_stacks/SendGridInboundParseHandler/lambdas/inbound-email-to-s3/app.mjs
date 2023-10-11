/**
 * inbound-email-to-s3
 * 
 * Lambda function that is triggered by API Gateway. 
 * Checks the request authorization header  (Basic Authenticate)
 * and if passes, dumps the base64 encoded string right into S3.
 * 
 * This lambda checks the basic auth and then saves the
 * payload directly into S3. Saving the new object into S3 triggers
 * a message to the SQS queue to initiated additional downstream
 * processing.
 * 
 */

// Libraries needed to save large objects to S3
// https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_lib_storage.html
import { Readable } from 'stream' 
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
const s3Client = new S3Client({ region: process.env.REGION });


export const lambdaHandler = async (event, context) => {
         
    //console.log(JSON.stringify(event, 2, null));  
       
    // Configure authentication, pull username and
    // password entered in SG to secure this webhook.
    const authUser = process.env.INBOUND_PARSE_USER;
    const authPass = process.env.INBOUND_PARSE_PASSWORD;

    // Construct the Basic Auth string expected
    const authString = 'Basic ' + Buffer.from(authUser + ':' + authPass).toString('base64');

    if (authString !== event.headers?.authorization) {
        
        // HANDLE FAILED CHECK OF AUTHORIZATION HEADER
        // Send notification or alarm...

        console.log("!!!!!!!!!!! Basic Authentication FAILED !!!!!!!!!!!");        

        return;

    } else {

        // Valid authorization header

        /**
         * PULL OUT BOUNDARY FOR MULTIPART FROM HEADER AND PUT IT IN THE KEY!
         * This boundary is extracted in the handle-sqs-messages lambda to
         * parse the multipart data. 
         */ 
        //"content-type": "multipart/form-data; boundary=xYzZY"
        let boundary = event.headers['content-type'].replace(/^.*boundary\=/,"");

        let now = new Date(); 
        let y = now.getFullYear().toString();
        let m = (now.getMonth() < 9 ? '0' : '') + (now.getMonth()+1).toString();
        let d = (now.getDate() < 10 ? '0' : '') + now.getDate().toString();
        // Create a date prefix so that objects in S3 bucket are organized
        // by date. Note, date is based on UTC time!
        let dateprefix = `${y}-${m}-${d}/`;

        // Key format sorts by date, then uses request id, and then includes
        // the boundary used to parse the email contents in the next lambda
        let key = `${dateprefix}${event.requestContext.requestId.replace("=","")}-boundary-${boundary}-email.b64`;

        // Pull the contents of the request body into a buffer
        // LEAVE email body encoded in Base64
        const buffer = Buffer.from(event.body);

        // Convert the buffer into a stream so that it can be save to S3
        const stream = Readable.from(buffer);          

        try {
            const parallelUploads3 = new Upload({
              client: s3Client,
              params: { Bucket:process.env.RAW_INBOUND_EMAIL_BUCKET, Key:key, Body:stream }          
            });
          
            parallelUploads3.on("httpUploadProgress", (progress) => {
              console.log(progress);
            });
          
            await parallelUploads3.done();
          } catch (e) {
            console.log(e);
          }        

    }

};