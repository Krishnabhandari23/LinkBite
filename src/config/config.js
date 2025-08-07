import dotenv from 'dotenv';

dotenv.config();

export const config = {
    port: process.env.PORT || 3000,
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    linktwApiKey: process.env.LINKTW_API_KEY,
    nodeEnv: process.env.NODE_ENV || 'development',
    
    // YouTube channel configuration
    channel: {
        handle: '@moonvlr5',
        url: 'https://www.youtube.com/@moonvlr5'
    },
    
    // API endpoints
    apis: {
        youtube: 'https://www.googleapis.com/youtube/v3',
        linktw: 'https://linktw.in/api'
    },
    
    // Cache settings
    cache: {
        duration: 2 * 60 * 1000 // 2 minutes in milliseconds
    }
};


module.exports = {
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: process.env.LOG_FILE || 'logs/app.log', // fallback to default
};

export default config;