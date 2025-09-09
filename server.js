import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

import {
    saveChannelConfiguration,
    updateChannelStates,
    removeChannelFromDatabase,
    saveMonitoringData,
    loadMonitoringData,
    logMonitoringEvent,
    getAllChannelsFromDatabase,
    testDatabaseConnection
} from './database.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration constants
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION) || 2 * 60 * 1000; // 2 minutes
const DEFAULT_MONITOR_INTERVAL = parseInt(process.env.DEFAULT_MONITOR_INTERVAL) || 60 * 1000; // 1 minute

// Dynamic monitoring state - supports multiple channels
let monitoringInstances = new Map(); // channelHandle -> monitoring instance
let globalCache = new Map(); // channelHandle -> cached data
let persistentChannels = new Map(); // channelHandle -> config data

// Monitoring instance structure (enhanced)
class MonitoringInstance {
    constructor(channelHandle, webhookUrl, interval = DEFAULT_MONITOR_INTERVAL, contentTypes = ['live']) {
        this.channelHandle = channelHandle;
        this.channelUrl = `https://www.youtube.com/${channelHandle}`;
        this.webhookUrl = webhookUrl;
        this.interval = interval;
        this.contentTypes = contentTypes;
        this.isMonitoring = false;
        this.intervalId = null;
        this.lastKnownStates = {
            live: false,
            latestVideoId: null,
            latestShortId: null
        };
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 5;
        this.lastChecked = null;
        this.startedAt = null;
    }

    async start() {
        if (this.isMonitoring) {
            return { success: false, message: 'Already monitoring this channel' };
        }

        console.log(`🚀 Starting monitoring for ${this.channelHandle} (${this.contentTypes.join(', ')})`);
        this.isMonitoring = true;
        this.consecutiveErrors = 0;
        this.startedAt = Date.now();

        // Start monitoring immediately
        await this.checkContent();

        // Set up interval with arrow function to preserve 'this' context
        this.intervalId = setInterval(async () => {
            await this.checkContent();
        }, this.interval);

        // Save to database
        await this.saveToDatabase();

        return { success: true, message: 'Monitoring started successfully' };
    }

    async checkContent() {
        try {
            console.log(`🔍 Checking content for ${this.channelHandle}...`);

            for (const contentType of this.contentTypes) {
                await this.checkContentType(contentType);
            }

            this.consecutiveErrors = 0;
            this.lastChecked = Date.now();
        } catch (error) {
            console.error(`❌ Monitoring error for ${this.channelHandle}:`, error.message);
            this.consecutiveErrors++;

            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                console.error(`❌ Too many consecutive errors for ${this.channelHandle}, stopping monitoring`);
                await this.stop();

                await this.sendWebhookNotification({
                    event: 'monitoring_error',
                    error: 'Monitoring stopped due to consecutive errors',
                    consecutiveErrors: this.consecutiveErrors
                });

                monitoringInstances.delete(this.channelHandle);
                persistentChannels.delete(this.channelHandle);
            }
        }
    }

    async checkContentType(contentType) {
        let result;

        switch (contentType) {
            case 'live':
                result = await checkIfChannelIsLive(this.channelHandle);
                await this.handleLiveStatusChange(result);
                break;
            case 'videos':
                result = await getLatestVideos(this.channelHandle, 1);
                await this.handleNewVideo(result);
                break;
            case 'shorts':
                result = await getLatestShorts(this.channelHandle, 1);
                await this.handleNewShort(result);
                break;
        }
    }

    // ✅ MISSING METHOD 1: saveToDatabase
    async saveToDatabase() {
        try {
            console.log(`💾 Saving ${this.channelHandle} to database...`);
            
            const result = await saveChannelConfiguration(this.channelHandle, {
                webhookUrl: this.webhookUrl,
                interval: this.interval,
                contentTypes: this.contentTypes,
                lastKnownStates: this.lastKnownStates
            });
            
            if (result.success) {
                console.log(`✅ Saved ${this.channelHandle} to database`);
                return { success: true };
            } else {
                console.error(`❌ Failed to save ${this.channelHandle} to database:`, result.error);
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error(`❌ Exception saving ${this.channelHandle}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // ✅ MISSING METHOD 2: updateStatesInDatabase
    async updateStatesInDatabase() {
        try {
            const result = await updateChannelStates(this.channelHandle, this.lastKnownStates);
            if (!result.success) {
                console.error(`⚠️ Failed to update states for ${this.channelHandle}:`, result.error);
            } else {
                console.log(`✅ Updated states for ${this.channelHandle} in database`);
            }
            return result;
        } catch (error) {
            console.error(`❌ Exception updating states for ${this.channelHandle}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    async handleLiveStatusChange(liveStatus) {
        if (liveStatus.isLive !== this.lastKnownStates.live) {
            console.log(`🔄 Live status changed for ${this.channelHandle}: ${this.lastKnownStates.live} → ${liveStatus.isLive}`);

            if (liveStatus.isLive && liveStatus.liveUrl) {
                // Channel went LIVE
                console.log(`🎉 ${this.channelHandle} just went LIVE!`);

                const shortenerResult = await shortenUrl(liveStatus.liveUrl);

                // Update cache
                globalCache.set(this.channelHandle, {
                    ...globalCache.get(this.channelHandle) || {},
                    shorturl: shortenerResult.shorturl,
                    lastChecked: Date.now(),
                    isLive: true,
                    liveUrl: liveStatus.liveUrl,
                    title: liveStatus.title,
                    thumbnail: liveStatus.thumbnail
                });

                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'stream_started',
                    isLive: true,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: liveStatus.liveUrl,
                    title: liveStatus.title,
                    shortenerService: shortenerResult.service,
                    method: liveStatus.method,
                    thumbnail: liveStatus.thumbnail
                });

            } else if (!liveStatus.isLive && this.lastKnownStates.live) {
                // Channel went OFFLINE
                console.log(`📺 ${this.channelHandle} went offline`);

                // Update cache
                globalCache.set(this.channelHandle, {
                    ...globalCache.get(this.channelHandle) || {},
                    isLive: false,
                    lastChecked: Date.now()
                });

                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'stream_ended',
                    isLive: false,
                    message: 'Stream has ended'
                });
            }

            this.lastKnownStates.live = liveStatus.isLive;
            
            // ✅ Save state changes to database
            await this.updateStatesInDatabase();
        }
    }

    async handleNewVideo(videoResult) {
        if (videoResult.success && videoResult.videos.length > 0) {
            const latestVideo = videoResult.videos[0];

            if (this.lastKnownStates.latestVideoId !== latestVideo.videoId) {
                console.log(`📹 New video detected for ${this.channelHandle}: ${latestVideo.title}`);

                const shortenerResult = await shortenUrl(latestVideo.url);

                await this.sendWebhookNotification({
                    event: 'new_video',
                    title: latestVideo.title,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: latestVideo.url,
                    thumbnail: latestVideo.thumbnail,
                    publishedAt: latestVideo.publishedAt,
                    viewCount: latestVideo.viewCount
                });

                this.lastKnownStates.latestVideoId = latestVideo.videoId;
                
                // ✅ Save state changes to database
                await this.updateStatesInDatabase();
            }
        }
    }

    async handleNewShort(shortResult) {
        if (shortResult.success && shortResult.shorts.length > 0) {
            const latestShort = shortResult.shorts[0];

            if (this.lastKnownStates.latestShortId !== latestShort.videoId) {
                console.log(`🎬 New short detected for ${this.channelHandle}: ${latestShort.title}`);

                const shortenerResult = await shortenUrl(latestShort.url);

                await this.sendWebhookNotification({
                    event: 'new_short',
                    title: latestShort.title,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: latestShort.url,
                    thumbnail: latestShort.thumbnail,
                    publishedAt: latestShort.publishedAt,
                    viewCount: latestShort.viewCount
                });

                this.lastKnownStates.latestShortId = latestShort.videoId;
                
                // ✅ Save state changes to database
                await this.updateStatesInDatabase();
            }
        }
    }

    async sendWebhookNotification(data) {
        if (!this.webhookUrl) {
            console.log(`⚠️  No webhook URL configured for ${this.channelHandle}, skipping notification`);
            return false;
        }

        try {
            console.log(`📤 Sending webhook notification for ${this.channelHandle}...`);

            let payload = formatDiscordMessage({
                ...data,
                channelHandle: this.channelHandle,
                channelUrl: this.channelUrl
            });

            const response = await axios.post(this.webhookUrl, payload, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'YouTube-Live-Monitor-Pro/2.0'
                }
            });

            if (response.status >= 200 && response.status < 300) {
                console.log(`✅ Webhook notification sent successfully for ${this.channelHandle}`);
                return true;
            } else {
                console.error(`❌ Webhook failed for ${this.channelHandle} with status:`, response.status);
                return false;
            }
        } catch (error) {
            console.error(`❌ Webhook notification failed for ${this.channelHandle}:`, error.response?.data || error.message);
            return false;
        }
    }

    async stop() {
        if (!this.isMonitoring) {
            return { success: false, message: 'Not currently monitoring' };
        }

        console.log(`🛑 Stopping monitoring for ${this.channelHandle}`);

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        this.isMonitoring = false;
        this.consecutiveErrors = 0;
        this.startedAt = null;

        // Remove from persistent channels and database
        persistentChannels.delete(this.channelHandle);
        await removeChannelFromDatabase(this.channelHandle);

        return { success: true, message: 'Monitoring stopped successfully' };
    }

    getStatus() {
        return {
            channelHandle: this.channelHandle,
            channelUrl: this.channelUrl,
            webhookUrl: this.webhookUrl ? this.webhookUrl.replace(/\/[^\/]*$/, '/***') : null,
            isMonitoring: this.isMonitoring,
            contentTypes: this.contentTypes,
            lastKnownStates: this.lastKnownStates,
            consecutiveErrors: this.consecutiveErrors,
            interval: this.interval,
            lastChecked: this.lastChecked ? new Date(this.lastChecked).toISOString() : null,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
            lastKnownLiveStatus: this.lastKnownStates.live
        };
    }
}

// Function to get channel ID from handle
async function getChannelIdFromHandle(handle) {
    try {
        const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
        const response = await axios.get(`https://www.youtube.com/${cleanHandle}`, {
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
                console.log(`✅ Found channel ID for ${handle}: ${match[1]}`);
                return match[1];
            }
        }

        throw new Error('Channel ID not found in page');
    } catch (error) {
        console.error(`❌ Error getting channel ID for ${handle}:`, error.message);
        throw error;
    }
}

// Function to check if channel is live using YouTube API
async function checkIfChannelIsLive(channelHandle) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            console.log(`⚠️  No YouTube API key found for ${channelHandle}, using fallback method`);
            return await checkLiveStatusFallback(channelHandle);
        }

        console.log(`🔍 Using YouTube API to check live status for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);

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

            console.log(`🎥 Found live stream for ${channelHandle}: ${liveVideo.snippet.title}`);
            return {
                isLive: true,
                liveUrl: liveUrl,
                title: liveVideo.snippet.title,
                thumbnail: liveVideo.snippet.thumbnails?.default?.url,
                videoId: liveVideo.id.videoId,
                method: 'api'
            };
        }

        console.log(`📺 No live streams found via API for ${channelHandle}`);
        return { isLive: false, liveUrl: null };

    } catch (error) {
        console.error(`❌ YouTube API failed for ${channelHandle}:`, error.message);
        console.log(`🔄 Trying fallback method for ${channelHandle}...`);
        return await checkLiveStatusFallback(channelHandle);
    }
}

// Function to get latest videos
async function getLatestVideos(channelHandle, maxResults = 10) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            return await getLatestVideosFallback(channelHandle, maxResults);
        }

        console.log(`🔍 Getting latest videos for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);

        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                type: 'video',
                order: 'date',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: maxResults
            },
            timeout: 15000
        });

        const videos = searchResponse.data.items.map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails?.default?.url,
            publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString(),
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            viewCount: 'N/A' // View count requires additional API call
        }));

        return {
            success: true,
            videos: videos,
            channel: channelHandle,
            method: 'api'
        };

    } catch (error) {
        console.error(`❌ Error getting videos for ${channelHandle}:`, error.message);
        return await getLatestVideosFallback(channelHandle, maxResults);
    }
}

// Function to get latest shorts
async function getLatestShorts(channelHandle, maxResults = 10) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            return await getLatestShortsFallback(channelHandle, maxResults);
        }

        console.log(`🔍 Getting latest shorts for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);

        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                type: 'video',
                order: 'date',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: maxResults * 2, // Get more to filter for shorts
                videoDuration: 'short' // Less than 4 minutes
            },
            timeout: 15000
        });

        // Filter for actual shorts (YouTube Shorts are typically under 60 seconds)
        const shorts = searchResponse.data.items
            .filter(item => {
                const title = item.snippet.title.toLowerCase();
                const description = item.snippet.description?.toLowerCase() || '';
                return title.includes('#shorts') || description.includes('#shorts') || 
                       title.includes('short') || description.includes('short');
            })
            .slice(0, maxResults)
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails?.default?.url,
                publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString(),
                url: `https://www.youtube.com/shorts/${item.id.videoId}`,
                viewCount: 'N/A' // View count requires additional API call
            }));

        return {
            success: true,
            shorts: shorts,
            channel: channelHandle,
            method: 'api'
        };

    } catch (error) {
        console.error(`❌ Error getting shorts for ${channelHandle}:`, error.message);
        return await getLatestShortsFallback(channelHandle, maxResults);
    }
}

// Fallback methods
async function checkLiveStatusFallback(channelHandle) {
    try {
        console.log(`🔍 Using fallback method to check live status for ${channelHandle}...`);

        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}`;

        const response = await axios.get(channelUrl, {
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

                console.log(`🎥 Found live stream via fallback for ${channelHandle}: ${title}`);
                return {
                    isLive: true,
                    liveUrl: liveUrl,
                    title: title,
                    videoId: videoId,
                    method: 'fallback'
                };
            }
        }

        console.log(`📺 No live streams found via fallback for ${channelHandle}`);
        return { isLive: false, liveUrl: null };

    } catch (error) {
        console.error(`❌ Fallback method failed for ${channelHandle}:`, error.message);
        return { isLive: false, liveUrl: null };
    }
}

async function getLatestVideosFallback(channelHandle, maxResults = 10) {
    try {
        console.log(`🔍 Using fallback method to get videos for ${channelHandle}...`);

        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}/videos`;

        const response = await axios.get(channelUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;
        const videoIds = [];
        const videoPattern = /"videoId":"([^"]+)"/g;
        let match;

        while ((match = videoPattern.exec(html)) !== null && videoIds.length < maxResults) {
            if (!videoIds.includes(match[1])) {
                videoIds.push(match[1]);
            }
        }

        const videos = videoIds.map(videoId => ({
            videoId: videoId,
            title: 'Recent Video',
            thumbnail: `https://img.youtube.com/vi/${videoId}/default.jpg`,
            publishedAt: 'Recent',
            url: `https://www.youtube.com/watch?v=${videoId}`,
            viewCount: 'N/A'
        }));

        return {
            success: true,
            videos: videos,
            channel: channelHandle,
            method: 'fallback'
        };

    } catch (error) {
        console.error(`❌ Fallback videos method failed for ${channelHandle}:`, error.message);
        return { success: false, videos: [], channel: channelHandle };
    }
}

async function getLatestShortsFallback(channelHandle, maxResults = 10) {
    try {
        console.log(`🔍 Using fallback method to get shorts for ${channelHandle}...`);

        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}/shorts`;

        const response = await axios.get(channelUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;
        const shortIds = [];
        const shortPattern = /"videoId":"([^"]+)"/g;
        let match;

        while ((match = shortPattern.exec(html)) !== null && shortIds.length < maxResults) {
            if (!shortIds.includes(match[1])) {
                shortIds.push(match[1]);
            }
        }

        const shorts = shortIds.map(videoId => ({
            videoId: videoId,
            title: 'Recent Short',
            thumbnail: `https://img.youtube.com/vi/${videoId}/default.jpg`,
            publishedAt: 'Recent',
            url: `https://www.youtube.com/shorts/${videoId}`,
            viewCount: 'N/A'
        }));

        return {
            success: true,
            shorts: shorts,
            channel: channelHandle,
            method: 'fallback'
        };

    } catch (error) {
        console.error(`❌ Fallback shorts method failed for ${channelHandle}:`, error.message);
        return { success: false, shorts: [], channel: channelHandle };
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
                    url: 'https://linktw.in/api/url/add',
                    method: 'POST',
                    data: { url: longUrl },
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': process.env.LINKTW_API_KEY 
                    }
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

                if (config.data) axiosConfig.data = config.data;

                const response = await axios(axiosConfig);

                let shorturl = null;

                if (typeof response.data === 'string') {
                    shorturl = response.data.trim();
                } else if (response.data) {
                    const fields = ['short_url', 'shorturl', 'shortened_url', 'url', 'link', 'short'];
                    for (const field of fields) {
                        if (response.data[field]) {
                            shorturl = response.data[field];
                            break;
                        }
                    }
                }

                if (shorturl && shorturl.startsWith('http') && shorturl !== longUrl) {
                    console.log(`✅ Successfully shortened with ${shortener.name}: ${shorturl}`);
                    return {
                        success: true,
