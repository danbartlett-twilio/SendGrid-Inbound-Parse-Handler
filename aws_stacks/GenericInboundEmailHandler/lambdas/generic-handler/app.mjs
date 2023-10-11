/**
 *  generic-handler
 * 
 * This is a simple Lambda function that is invoked by SNS messages.
 * Build off of this lambda function to meet your business requirements.
 */

export const lambdaHandler = async (event, context) => {
    
    let messageBody = JSON.parse(event.Records[0].Sns.Message);

    console.info("EVENT\n" + JSON.stringify(event, null, 2));    
    console.info("Message\n" + JSON.stringify(messageBody, null, 2));

    /**
     * What next?
     * 
     * => Forward / notify appropriate person
     * => Update your CDP or CRM or Datastore
     * => Connect to a chatbot
     * => Whatever else your business requires!
     * 
     */

};