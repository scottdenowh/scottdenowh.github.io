const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
admin.initializeApp();

// Get a reference to the Firestore service
const db = admin.firestore();

// HTTP function to read the schedule data from Firestore
exports.getScheduleData = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  try {
    const scheduleDocRef = db.collection('config').doc('schedule');
    const doc = await scheduleDocRef.get();

    if (!doc.exists) {
      functions.logger.info('Schedule document not found, returning empty default.');
      // Return a default empty structure or a specific error if preferred
      res.status(200).json({ schedules: [], scheduleGroups: [] }); 
    } else {
      res.status(200).json(doc.data());
    }
  } catch (error) {
    functions.logger.error('Error getting schedule data from Firestore:', error);
    res.status(500).send('Error reading schedule data');
  }
});

// HTTP function to update the schedule data in Firestore
exports.updateScheduleData = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // --- Authentication Check (CRUCIAL for security) ---
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
    functions.logger.error('No authorization token was provided or token format is incorrect.');
    res.status(403).send('Unauthorized: Missing or malformed Authorization header.');
    return;
  }
  const idToken = req.headers.authorization.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    functions.logger.info('ID Token correctly decoded. UID:', decodedToken.uid);
    // Optional: Add further checks here to ensure the UID is an authorized admin
    // For example, check against a list of admin UIDs in Firestore:
    // const adminUsersRef = db.collection('admins').doc(decodedToken.uid);
    // const adminDoc = await adminUsersRef.get();
    // if (!adminDoc.exists) {
    //   functions.logger.error('User is not an authorized admin. UID:', decodedToken.uid);
    //   res.status(403).send('Unauthorized: User is not an admin.');
    //   return;
    // }
  } catch (error) {
    functions.logger.error('Error while verifying Firebase ID token:', error);
    res.status(403).send('Unauthorized: Invalid ID token.');
    return;
  }
  // --- End Authentication Check ---

  try {
    const updatedData = req.body; // Expects the full schedule object
    if (!updatedData || typeof updatedData !== 'object' || !updatedData.schedules || !updatedData.scheduleGroups) {
      functions.logger.error('Invalid data format received:', updatedData);
      res.status(400).send('Invalid data format received.');
      return;
    }

    const scheduleDocRef = db.collection('config').doc('schedule');
    await scheduleDocRef.set(updatedData); // .set() will create or overwrite
    
    functions.logger.info('Schedule updated successfully in Firestore.');
    res.status(200).json({ message: 'Schedule updated successfully in Firestore.' });

  } catch (error) {
    functions.logger.error('Error updating schedule data in Firestore:', error);
    res.status(500).send('Error updating schedule data');
  }
});

exports.sendNotification = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    // Only allow POST requests
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    try {
        // Get the notification data from the request
        const { title, body } = req.body;

        if (!title || !body) {
            res.status(400).send('Title and body are required');
            return;
        }

        // Get all FCM tokens from the database
        const tokensSnapshot = await admin.database().ref('fcmTokens').once('value');
        const tokens = tokensSnapshot.val();

        if (!tokens) {
            console.log('No tokens found in database');
            res.status(200).send('No devices registered for notifications');
            return;
        }

        const tokenList = Object.keys(tokens);
        console.log(`Attempting to send to ${tokenList.length} devices`);

        if (tokenList.length === 0) {
            console.log('Token list is empty');
            res.status(200).send('No valid tokens found');
            return;
        }

        // Send to each token individually
        const results = await Promise.allSettled(
            tokenList.map(token => {
                const message = {
                    notification: {
                        title,
                        body
                    },
                    token
                };
                return admin.messaging().send(message);
            })
        );

        // Process results
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        // Remove failed tokens
        const failedTokens = results
            .map((result, index) => result.status === 'rejected' ? tokenList[index] : null)
            .filter(Boolean);

        if (failedTokens.length > 0) {
            const updates = {};
            failedTokens.forEach(token => {
                updates[`fcmTokens/${token}`] = null;
            });
            await admin.database().ref().update(updates);
        }

        // Log the notification
        const notificationLog = {
            timestamp: admin.database.ServerValue.TIMESTAMP,
            title,
            body,
            totalDevices: tokenList.length,
            successful,
            failed,
            failedTokens
        };

        // Add to notification logs
        await admin.database().ref('notificationLogs').push(notificationLog);

        res.status(200).json({
            success: true,
            message: `Successfully sent to ${successful} devices, failed for ${failed} devices`,
            failedTokens
        });

    } catch (error) {
        console.error('Error sending notification:', error);
        res.status(500).send('Error sending notification: ' + error.message);
    }
});
