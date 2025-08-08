const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Configuration
const CHANNEL_HANDLE = '@hailhydragaming';
const CHANNEL_URL = 'https://www.youtube.com/@hailhydragaming';
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes
const MONITOR_INTERVAL = 28800; // Check 8 hrs interval
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // Add your webhook URL to .env file

// Cache storage
let cachedLiveData = {
    shortUrl: null,
    lastChecked: null,
    isLive: false,
    liveUrl: null,
    title: null
};

// Monitoring state
let monitoringState = {
    isMonitoring: false,
    intervalId: null,
    lastKnownLiveStatus: false,
    consecutiveErrors: 0,
    maxConsecutiveErrors: 9999999999
};

// Function to get channel ID from handle
async function getChannelIdFromHandle(handle) {
    try {
        const cleanHandle = handle.replace('@', '');
        const response = await axios.get(`https://www.youtube.com/${handle}`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = response.data;
        
        // Try to find channel ID in various formats
        const patterns = [
            /"channelId":"([^"]+)"/,
            /"externalId":"([^"]+)"/,
            /channel\/([a-zA-Z0-9_-]{24})/,
            /"browseId":"([^"]+)"/
        ];
        
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
                console.log(`✅ Found channel ID: ${match[1]}`);
                return match[1];
            }
        }
        
        throw new Error('Channel ID not found in page');
    } catch (error) {
        console.error('❌ Error getting channel ID:', error.message);
        throw error;
    }
}

// Function to check if channel is live using YouTube API
async function checkIfChannelIsLive() {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            console.log('⚠️  No YouTube API key found, using fallback method');
            return await checkLiveStatusFallback();
        }

        console.log('🔍 Using YouTube API to check live status...');
        const channelId = await getChannelIdFromHandle(CHANNEL_HANDLE);
        
        // Search for live streams from this channel
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                eventType: 'live',
                type: 'video',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: 1
            },
            timeout: 15000
        });

        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            const liveVideo = searchResponse.data.items[0];
            const liveUrl = `https://www.youtube.com/watch?v=${liveVideo.id.videoId}`;
            
            console.log(`🎥 Found live stream: ${liveVideo.snippet.title}`);
            return {
                isLive: true,
                liveUrl: liveUrl,
                title: liveVideo.snippet.title,
                thumbnail: liveVideo.snippet.thumbnails?.default?.url,
                videoId: liveVideo.id.videoId
            };
        }

        console.log('📺 No live streams found via API');
        return { isLive: false, liveUrl: null };
        
    } catch (error) {
        console.error('❌ YouTube API failed:', error.message);
        console.log('🔄 Trying fallback method...');
        return await checkLiveStatusFallback();
    }
}

// Fallback method to check live status
async function checkLiveStatusFallback() {
    try {
        console.log('🔍 Using fallback method to check live status...');
        
        // Method 1: Try to scrape the channel page directly
        const response = await axios.get(CHANNEL_URL, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const html = response.data;
        
        // Look for live stream indicators
        const livePatterns = [
            /"isLiveContent":true.*?"videoId":"([^"]+)"/,
            /"isLive":true.*?"videoId":"([^"]+)"/,
            /watching now.*?"videoId":"([^"]+)"/i,
            /"LIVE".*?"videoId":"([^"]+)"/,
            /"badges":\[{"metadataBadgeRenderer":{"style":"BADGE_STYLE_TYPE_LIVE_NOW".*?"videoId":"([^"]+)"/
        ];
        
        for (const pattern of livePatterns) {
            const match = html.match(pattern);
            if (match) {
                const videoId = match[1];
                const liveUrl = `https://www.youtube.com/watch?v=${videoId}`;
                
                // Try to get title
                const titleMatch = html.match(new RegExp(`"videoId":"${videoId}".*?"title":"([^"]+)"`));
                const title = titleMatch ? titleMatch[1] : 'Live Stream';
                
                console.log(`🎥 Found live stream via fallback: ${title}`);
                return {
                    isLive: true,
                    liveUrl: liveUrl,
                    title: title,
                    videoId: videoId,
                    method: 'fallback'
                };
            }
        }
        
        // Method 2: Check for LIVE badge in a simpler way
        if (html.includes('"isLiveContent":true') || html.includes('BADGE_STYLE_TYPE_LIVE_NOW')) {
            console.log('🎥 Live content detected but couldn\'t extract video ID');
            // Could return the channel URL as fallback
            return {
                isLive: true,
                liveUrl: CHANNEL_URL,
                title: 'Live Stream (Check Channel)',
                method: 'fallback_basic'
            };
        }

        console.log('📺 No live streams found via fallback');
        return { isLive: false, liveUrl: null };
        
    } catch (error) {
        console.error('❌ Fallback method failed:', error.message);
        return { isLive: false, liveUrl: null };
    }
}

// Function to shorten URL using multiple services
async function shortenUrl(longUrl) {
    console.log(`🔗 Attempting to shorten URL: ${longUrl}`);
    
    const shorteners = [
        {
            name: 'linktw.in',
            methods: [
                {
                    url: 'https://linktw.in/api/url',
                    method: 'POST',
                    data: { url: longUrl },
                    headers: { 'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.LINKTW_API_KEY}` || ''  
                        
                    }
                },
                {
                    url: 'https://linktw.in/api/shorten',
                    method: 'POST', 
                    data: { url: longUrl },
                    headers: { 'Content-Type': 'application/json' }
                }
            ]
        },
        {
            name: 'TinyURL',
            methods: [
                {
                    url: `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
                    method: 'GET'
                }
            ]
        },
        {
            name: 'is.gd',
            methods: [
                {
                    url: 'https://is.gd/create.php',
                    method: 'POST',
                    data: `format=simple&url=${encodeURIComponent(longUrl)}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            ]
        }
    ];

    for (const shortener of shorteners) {
        for (const config of shortener.methods) {
            try {
                console.log(`🔄 Trying ${shortener.name}...`);
                
                const axiosConfig = {
                    method: config.method,
                    url: config.url,
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        ...config.headers
                    }
                };

                if (config.data) {
                    axiosConfig.data = config.data;
                }

                const response = await axios(axiosConfig);
                let shortUrl = null;

                // Handle different response formats
                if (typeof response.data === 'string') {
                    shortUrl = response.data.trim();
                } else if (response.data) {
                    // Try common field names
                    const fields = ['short_url', 'shortUrl', 'shortened_url', 'url', 'link', 'short','shorturl'];
                    for (const field of fields) {
                        if (response.data[field]) {
                            shortUrl = response.data[field];
                            break;
                        }
                    }
                }

                // Validate URL
                if (shortUrl && shortUrl.startsWith('http') && shortUrl !== longUrl) {
                    console.log(`✅ Successfully shortened with ${shortener.name}: ${shortUrl}`);
                    return {
                        success: true,
                        shortUrl: shortUrl,
                        originalUrl: longUrl,
                        service: shortener.name
                    };
                }
                
            } catch (error) {
                console.log(`❌ ${shortener.name} failed: ${error.message}`);
                continue;
            }
        }
    }

    // All shorteners failed, return original URL
    console.warn('⚠️  All URL shortening services failed, returning original URL');
    return {
        success: false,
        shortUrl: longUrl,
        originalUrl: longUrl,
        service: 'none',
        error: 'All shortening services failed'
    };
}
//format discord message
function formatDiscordMessage(data) {
    const baseEmbed = {
        color: 0x5865F2, // Default blue
        footer: { text: "YouTube Live Monitor" },
        timestamp: new Date().toISOString()
    };

    switch (data.event) {
        case 'stream_started':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: `🔴 ${data.title || 'Live Now!'}`,
                    description: `${CHANNEL_HANDLE} is now live on YouTube!\n\n[Watch Here](${data.shortUrl})`,
                    url: data.shortUrl,
                    color: 0xFF0000, // Red
                    thumbnail: {
                        url: data.thumbnail || 'https://i.imgur.com/4M34hi2.png'
                    },
                    fields: [
                        {
                            name: "Channel",
                            value: `[${CHANNEL_HANDLE}](${CHANNEL_URL})`,
                            inline: true
                        },
                        {
                            name: "Short Link",
                            value: `[${data.shortUrl.replace(/^https?:\/\//, '')}](${data.shortUrl})`,
                            inline: true
                        }
                    ]
                }]
            };

        case 'stream_ended':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '📴 Stream Ended',
                    description: `${CHANNEL_HANDLE}'s stream has ended.`,
                    color: 0x808080 // Gray
                }]
            };

        case 'monitoring_error':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '⚠️ Monitoring Error',
                    description: `Too many errors while checking ${CHANNEL_HANDLE}`,
                    color: 0xFFA500, // Orange
                    fields: [
                        {
                            name: 'Consecutive Errors',
                            value: `${data.consecutiveErrors || 0}`,
                            inline: true
                        }
                    ]
                }]
            };

        case 'test':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '🧪 Test Webhook',
                    description: 'This is a test notification from the YouTube monitor system.',
                    color: 0x00FF00 // Green
                }]
            };

        default:
            return {
                content: `📡 Event from ${CHANNEL_HANDLE}: \`${data.event}\`\n${data.message || ''}`
            };
    }
}



// Function to send webhook notification
async function sendWebhookNotification(data) {
    if (!WEBHOOK_URL) {
        console.log('⚠️  No webhook URL configured, skipping notification');
        return false;
    }

    try {
        console.log('📤 Sending webhook notification...');

        let payload;

        // Use embed format for stream_started event
        if (data.event === 'stream_started') {
            payload = formatDiscordMessage({
                ...data,
                shortUrl: data.shortUrl,
                title: data.title,
                thumbnail: data.thumbnail
            });
        } else {
            // Simple message for other events like stream_ended, test, errors, etc.
            payload = {
                content: `📡 **${CHANNEL_HANDLE}** event: \`${data.event}\`\n${data.message || ''}`
            };
        }

        const response = await axios.post(WEBHOOK_URL, payload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'YouTube-Live-Monitor/1.0'
            }
        });

        if (response.status >= 200 && response.status < 300) {
            console.log('✅ Webhook notification sent successfully');
            return true;
        } else {
            console.error('❌ Webhook failed with status:', response.status);
            return false;
        }
    } catch (error) {
        console.error('❌ Webhook notification failed:', error.response?.data || error.message);
        return false;
    }
}


// Function to monitor live status
async function monitorLiveStatus() {
    try {
        console.log('🔍 Monitoring: Checking live status...');
        const liveStatus = await checkIfChannelIsLive();
        
        // Reset consecutive errors on successful check
        monitoringState.consecutiveErrors = 0;

        // Check if live status changed
        if (liveStatus.isLive !== monitoringState.lastKnownLiveStatus) {
            console.log(`🔄 Live status changed: ${monitoringState.lastKnownLiveStatus} → ${liveStatus.isLive}`);
            
            if (liveStatus.isLive && liveStatus.liveUrl) {
                // Channel went LIVE
                console.log('🎉 Channel just went LIVE! Creating short link...');
                
                const shortenerResult = await shortenUrl(liveStatus.liveUrl);
                
                // Update cache
                const now = Date.now();
                cachedLiveData = {
                    shortUrl: shortenerResult.shortUrl,
                    lastChecked: now,
                    isLive: true,
                    liveUrl: liveStatus.liveUrl,
                    title: liveStatus.title
                };

                // Send webhook notification
                await sendWebhookNotification({
                    event: 'stream_started',
                    isLive: true,
                    shortUrl: shortenerResult.shortUrl,
                    originalUrl: liveStatus.liveUrl,
                    title: liveStatus.title,
                    shortenerService: shortenerResult.service,
                    method: liveStatus.method,
                    thumbnail: liveStatus.thumbnail
                });

                console.log(`✅ Live stream notification sent: ${shortenerResult.shortUrl}`);
                
            } else if (!liveStatus.isLive && monitoringState.lastKnownLiveStatus) {
                // Channel went OFFLINE
                console.log('📺 Channel went offline');
                
                // Update cache
                cachedLiveData = {
                    shortUrl: null,
                    lastChecked: Date.now(),
                    isLive: false,
                    liveUrl: null,
                    title: null
                };

                // Send webhook notification
                await sendWebhookNotification({
                    event: 'stream_ended',
                    isLive: false,
                    message: 'Stream has ended'
                });
            }
            
            // Update last known status
            monitoringState.lastKnownLiveStatus = liveStatus.isLive;
        } else {
            console.log(`📊 Status unchanged: ${liveStatus.isLive ? 'LIVE' : 'OFFLINE'}`);
        }

    } catch (error) {
        console.error('❌ Monitoring error:', error.message);
        monitoringState.consecutiveErrors++;
        
        // Stop monitoring if too many consecutive errors
        if (monitoringState.consecutiveErrors >= monitoringState.maxConsecutiveErrors) {
            console.error('❌ Too many consecutive errors, stopping monitoring');
            stopMonitoring();
            
            // Send error webhook
            await sendWebhookNotification({
                event: 'monitoring_error',
                error: 'Monitoring stopped due to consecutive errors',
                consecutiveErrors: monitoringState.consecutiveErrors
            });
        }
    }
}

// Function to start monitoring
function startMonitoring() {
    if (monitoringState.isMonitoring) {
        console.log('⚠️  Monitoring is already running');
        return false;
    }

    console.log('🚀 Starting automatic live stream monitoring...');
    console.log(`🕒 Check interval: ${MONITOR_INTERVAL / 1000}s`);
    console.log(`📡 Webhook URL: ${WEBHOOK_URL ? '✅ Configured' : '❌ Not configured'}`);
    
    monitoringState.isMonitoring = true;
    monitoringState.consecutiveErrors = 0;
    
    // Start monitoring immediately
    monitorLiveStatus();
    
    // Set up interval
    monitoringState.intervalId = setInterval(monitorLiveStatus, MONITOR_INTERVAL);
    
    return true;
}

// Function to stop monitoring
function stopMonitoring() {
    if (!monitoringState.isMonitoring) {
        console.log('⚠️  Monitoring is not running');
        return false;
    }

    console.log('🛑 Stopping automatic live stream monitoring...');
    
    if (monitoringState.intervalId) {
        clearInterval(monitoringState.intervalId);
        monitoringState.intervalId = null;
    }
    
    monitoringState.isMonitoring = false;
    monitoringState.consecutiveErrors = 0;
    
    return true;
}

// Main API endpoint (unchanged)
app.get('/api/live-link', async (req, res) => {
    try {
        const now = Date.now();
        
        // Check cache
        if (cachedLiveData.lastChecked && (now - cachedLiveData.lastChecked) < CACHE_DURATION) {
            console.log('📋 Returning cached data');
            return res.json({
                success: true,
                cached: true,
                isLive: cachedLiveData.isLive,
                shortUrl: cachedLiveData.shortUrl,
                originalUrl: cachedLiveData.liveUrl,
                title: cachedLiveData.title,
                channel: CHANNEL_HANDLE,
                lastChecked: new Date(cachedLiveData.lastChecked).toISOString(),
                cacheExpiresIn: Math.max(0, CACHE_DURATION - (now - cachedLiveData.lastChecked))
            });
        }

        console.log(`🔍 Checking if ${CHANNEL_HANDLE} is live...`);
        const liveStatus = await checkIfChannelIsLive();

        if (liveStatus.isLive && liveStatus.liveUrl) {
            console.log('🎥 Channel is LIVE! Shortening URL...');
            
            // Shorten the live URL
            const shortenerResult = await shortenUrl(liveStatus.liveUrl);
            
            // Update cache
            cachedLiveData = {
                shortUrl: shortenerResult.shortUrl,
                lastChecked: now,
                isLive: true,
                liveUrl: liveStatus.liveUrl,
                title: liveStatus.title
            };

            res.json({
                success: true,
                isLive: true,
                shortUrl: shortenerResult.shortUrl,
                originalUrl: liveStatus.liveUrl,
                title: liveStatus.title,
                channel: CHANNEL_HANDLE,
                shortenerService: shortenerResult.service,
                method: liveStatus.method,
                lastChecked: new Date(now).toISOString(),
                thumbnail: liveStatus.thumbnail
            });
        } else {
            console.log(`📺 ${CHANNEL_HANDLE} is not currently live`);
            
            // Update cache
            cachedLiveData = {
                shortUrl: null,
                lastChecked: now,
                isLive: false,
                liveUrl: null,
                title: null
            };

            res.json({
                success: true,
                isLive: false,
                message: `${CHANNEL_HANDLE} is not currently live`,
                channel: CHANNEL_HANDLE,
                channelUrl: CHANNEL_URL,
                lastChecked: new Date(now).toISOString()
            });
        }
    } catch (error) {
        console.error('❌ API Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            channel: CHANNEL_HANDLE,
            timestamp: new Date().toISOString()
        });
    }
});

// NEW MONITORING ENDPOINTS

// Start monitoring endpoint
app.post('/api/monitoring/start', (req, res) => {
    try {
        const started = startMonitoring();
        
        if (started) {
            res.json({
                success: true,
                message: 'Monitoring started successfully',
                config: {
                    channel: CHANNEL_HANDLE,
                    interval: MONITOR_INTERVAL / 1000,
                    webhookConfigured: !!WEBHOOK_URL
                },
                status: monitoringState
            });
        } else {
            res.json({
                success: false,
                message: 'Monitoring is already running',
                status: monitoringState
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Stop monitoring endpoint
app.post('/api/monitoring/stop', (req, res) => {
    try {
        const stopped = stopMonitoring();
        
        res.json({
            success: true,
            message: stopped ? 'Monitoring stopped successfully' : 'Monitoring was not running',
            status: monitoringState
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Monitoring status endpoint
app.get('/api/monitoring/status', (req, res) => {
    res.json({
        success: true,
        monitoring: {
            ...monitoringState,
            config: {
                channel: CHANNEL_HANDLE,
                interval: MONITOR_INTERVAL / 1000,
                webhookConfigured: !!WEBHOOK_URL,
                webhookUrl: WEBHOOK_URL ? WEBHOOK_URL.replace(/\/[^\/]*$/, '/***') : null // Hide sensitive parts
            }
        },
        cache: {
            ...cachedLiveData,
            lastChecked: cachedLiveData.lastChecked ? new Date(cachedLiveData.lastChecked).toISOString() : null
        }
    });
});

// Test webhook endpoint
app.post('/api/monitoring/test-webhook', async (req, res) => {
    try {
        const success = await sendWebhookNotification({
            event: 'test',
            message: 'This is a test webhook notification',
            timestamp: new Date().toISOString()
        });

        res.json({
            success: success,
            message: success ? 'Test webhook sent successfully' : 'Test webhook failed',
            webhookUrl: WEBHOOK_URL ? WEBHOOK_URL.replace(/\/[^\/]*$/, '/***') : 'Not configured'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint (updated)
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'YouTube Live Stream Shortener API',
        channel: CHANNEL_HANDLE,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        monitoring: {
            isActive: monitoringState.isMonitoring,
            lastKnownStatus: monitoringState.lastKnownLiveStatus,
            consecutiveErrors: monitoringState.consecutiveErrors
        },
        cache: {
            lastChecked: cachedLiveData.lastChecked ? new Date(cachedLiveData.lastChecked).toISOString() : null,
            isLive: cachedLiveData.isLive
        }
    });
});

// Channel info endpoint (updated)
app.get('/api/channel-info', (req, res) => {
    res.json({
        success: true,
        channel: {
            handle: CHANNEL_HANDLE,
            url: CHANNEL_URL,
            name: 'moonvlr5'
        },
        api: {
            version: '2.0.0',
            endpoints: [
                'GET /api/live-link - Get shortened live stream URL',
                'GET /health - Health check',
                'GET /api/channel-info - Channel information',
                'POST /api/refresh - Force refresh cache',
                'POST /api/monitoring/start - Start automatic monitoring',
                'POST /api/monitoring/stop - Stop automatic monitoring',
                'GET /api/monitoring/status - Get monitoring status',
                'POST /api/monitoring/test-webhook - Test webhook notification'
            ]
        },
        features: [
            'Live stream detection',
            'URL shortening with multiple services',
            'Response caching',
            'Fallback methods',
            'Automatic monitoring',
            'Webhook notifications',
            'Error handling and recovery'
        ]
    });
});

// Manual refresh endpoint (unchanged)
app.post('/api/refresh', async (req, res) => {
    try {
        console.log('🔄 Manual refresh requested - clearing cache...');
        
        // Clear cache
        cachedLiveData = {
            shortUrl: null,
            lastChecked: null,
            isLive: false,
            liveUrl: null,
            title: null
        };

        // Force check
        const liveStatus = await checkIfChannelIsLive();
        
        if (liveStatus.isLive && liveStatus.liveUrl) {
            const shortenerResult = await shortenUrl(liveStatus.liveUrl);
            
            cachedLiveData = {
                shortUrl: shortenerResult.shortUrl,
                lastChecked: Date.now(),
                isLive: true,
                liveUrl: liveStatus.liveUrl,
                title: liveStatus.title
            };

            res.json({
                success: true,
                message: 'Cache refreshed - Channel is LIVE!',
                isLive: true,
                shortUrl: shortenerResult.shortUrl,
                originalUrl: liveStatus.liveUrl,
                title: liveStatus.title
            });
        } else {
            res.json({
                success: true,
                message: 'Cache refreshed - Channel is not live',
                isLive: false
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    stopMonitoring();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    stopMonitoring();
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log('🚀 YouTube Live Shortener API Started!');
    console.log('─'.repeat(60));
    console.log(`📍 Server: http://localhost:${PORT}`);
    console.log(`📺 Channel: ${CHANNEL_HANDLE}`);
    console.log(`🔗 API: http://localhost:${PORT}/api/live-link`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log(`🔍 Monitoring: http://localhost:${PORT}/api/monitoring/status`);
    console.log('─'.repeat(60));
    console.log('🔧 Configuration:');
    console.log(`   YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Configured' : '⚠️  Using fallback'}`);
    console.log(`   Webhook URL: ${WEBHOOK_URL ? '✅ Configured' : '⚠️  Not configured'}`);
    console.log(`   Cache: ${CACHE_DURATION / 1000}s`);
    console.log(`   Monitor Interval: ${MONITOR_INTERVAL / 1000}s`);
    console.log('─'.repeat(60));
    console.log('Ready to monitor live streams! 🎬');
    console.log('💡 To start monitoring: POST /api/monitoring/start');
    startMonitoring();
});

module.exports = app;







