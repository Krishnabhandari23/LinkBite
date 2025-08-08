const express = require('express');
const streamController = require('../controllers/streamController');
const shortenerController = require('../controllers/shortenerController');
app.use(express.static(path.join(__dirname, 'public')));
const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date()
  });
});
//default page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/api/live-link', async (req, res) => {
    try {
        // Get channel from query parameter or use default
        const channelHandle = req.query.channel || CHANNEL_HANDLE;
        const channelUrl = `https://www.youtube.com/${CHANNEL_HANDLE}`;
        
        // Rest of your existing code...
        // Replace all CHANNEL_HANDLE references with channelHandle
        // Replace CHANNEL_URL with channelUrl
    } catch (error) {
        // error handling
    }
});
// Stream routes
router.get('/live-streams', streamController.getCurrentStreams);
router.get('/streams/all', streamController.getAllStreams);
router.get('/streams/:videoId', streamController.getStreamById);
router.post('/check-now', streamController.checkNow);
router.get('/channel', streamController.getChannelInfo);
router.post('/monitoring/:action', streamController.controlMonitoring);

// Shortener routes
router.post('/shorten', shortenerController.createShortLink);


module.exports = router;


