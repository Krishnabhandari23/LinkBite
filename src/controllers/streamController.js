const youtubeService = require('../services/youtubeService').default;
const logger = require('../utils/logger');

class StreamController {
  async getCurrentStreams(req, res, next) {
    try {
      const currentLive = youtubeService.getCurrentLiveStreams();
      const channelInfo = youtubeService.getChannelInfo();
      
      res.json({
        success: true,
        count: currentLive.length,
        streams: currentLive,
        channel: channelInfo
      });
    } catch (error) {
      next(error);
    }
  }

  async getAllStreams(req, res, next) {
    try {
      const allStreams = youtubeService.getAllStreams();
      
      res.json({
        success: true,
        count: allStreams.length,
        streams: allStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async getStreamById(req, res, next) {
    try {
      const { videoId } = req.params;
      const stream = youtubeService.getStreamById(videoId);
      
      if (!stream) {
        return res.status(404).json({
          success: false,
          error: 'Stream not found'
        });
      }
      
      res.json({
        success: true,
        stream: stream
      });
    } catch (error) {
      next(error);
    }
  }

  async checkNow(req, res, next) {
    try {
      logger.info('Manual stream check triggered');
      const currentStreams = await youtubeService.checkLiveStreams();
      
      res.json({
        success: true,
        message: 'Live stream check completed',
        currentStreams: currentStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async getChannelInfo(req, res, next) {
    try {
      const channelInfo = youtubeService.getChannelInfo();
      const isMonitoring = youtubeService.isMonitoringActive();
      
      res.json({
        success: true,
        channel: channelInfo,
        monitoring: isMonitoring
      });
    } catch (error) {
      next(error);
    }
  }

  async controlMonitoring(req, res, next) {
    try {
      const { action } = req.params;
      
      if (action === 'start') {
        if (!youtubeService.isMonitoringActive()) {
          youtubeService.startMonitoring();
          res.json({ success: true, message: 'Monitoring started' });
        } else {
          res.json({ success: true, message: 'Already monitoring' });
        }
      } else if (action === 'stop') {
        youtubeService.stopMonitoring();
        res.json({ success: true, message: 'Monitoring stopped' });
      } else {
        res.status(400).json({ 
          success: false, 
          error: 'Invalid action. Use "start" or "stop"' 
        });
      }
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new StreamController();