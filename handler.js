const AWS = require('aws-sdk');
const { google } = require('googleapis');
const bedrock = new AWS.BedrockRuntime();
const sns = new AWS.SNS();

async function getGoogleFitSteps() {

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    access_token: process.env.GOOGLE_ACCESS_TOKEN
  });

  try {
    await oauth2Client.getAccessToken();
    console.log('Successfully refreshed Google access token');
  } catch (tokenError) {
    console.error('Failed to refresh access token:', tokenError);
    throw new Error('Invalid refresh token or expired credentials');
  }

  const fitness = google.fitness({ version: 'v1', auth: oauth2Client });
  
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  console.log(`Fetching steps for ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

  const response = await fitness.users.dataset.aggregate({
    userId: 'me',
    requestBody: {
      aggregateBy: [{
        dataTypeName: 'com.google.step_count.delta',
        dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps'
      }],
      bucketByTime: { durationMillis: 24 * 60 * 60 * 1000 }, // 1 day
      startTimeMillis: startOfDay.getTime(),
      endTimeMillis: endOfDay.getTime()
    }
  });

  const bucket = response.data.bucket?.[0];
  if (!bucket || !bucket.dataset || bucket.dataset.length === 0) {
    console.log('No step data found for today');
    return 0;
  }

  const dataset = bucket.dataset[0];
  if (!dataset.point || dataset.point.length === 0) {
    console.log('No step points found for today');
    return 0;
  }

  const steps = dataset.point[0]?.value?.[0]?.intVal || 0;
  console.log(`Retrieved ${steps} steps from Google Fit`);
  return steps;
}

async function getRoastMessage() {
  try {
    const prompt = `You are a sarcastic fitness coach who's fed up with laziness.
Write short, passive-aggressive messages for users who have taken 0–100 steps today according to their fitness tracker.
The tone should be funny, judgmental, and lightly insulting — not offensive, but enough to guilt the user into moving.
Think of how a friend who roasts you would say it.
Generate one short roast message`;

    const modelId = 'anthropic.claude-3-haiku-20240307-v1:0';
    
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const params = {
      modelId: modelId,
      body: body,
      contentType: 'application/json',
      accept: 'application/json'
    };

    const response = await bedrock.invokeModel(params).promise();
    const responseBody = JSON.parse(response.body.toString());
    
    return responseBody.content[0].text.trim();
  } catch (error) {
    console.error('Error getting roast message from Bedrock:', error);
    throw error;
  }
}

async function sendSNSMessage(message, steps) {
  try {
    const fullMessage = `Steps${steps}\n\n${message}`;
    
    const params = {
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: fullMessage,
      Subject: 'Your Daily Step Count Roast'
    };

    await sns.publish(params).promise();
    console.log('SNS message sent successfully');
  } catch (error) {
    console.error('Error sending SNS message:', error);
    throw error;
  }
}

exports.run = async (event) => {
  try {
    console.log('Starting daily step check...');
    
    const steps = await getGoogleFitSteps();
    console.log(`Today's step count: ${steps}`);
    
    if (steps < 100) {
      console.log('Steps are below 100, generating roast message...');
      
      const roastMessage = await getRoastMessage();
      console.log('Roast message generated:', roastMessage);
      
      await sendSNSMessage(roastMessage, steps);
      console.log(roastMessage, steps);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Roast message sent successfully!',
          steps: steps,
          roast: roastMessage
        })
      };
    } else {
      console.log('Steps are above 100, no roasting needed today!');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Good job! No roasting needed today.',
          steps: steps
        })
      };
    }
    
  } catch (error) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to process step check',
        details: error.message
      })
    };
  }
};
