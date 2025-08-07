const shortenerService = require('../services/shortenerService');

class ShortenerController {
  async createShortLink(req, res, next) {
    try {
      const { url, title } = req.body;
      
      if (!url) {
        return res.status(400).json({
          success: false,
          error: 'URL is required'
        });
      }
      
      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL format'
        });
      }
      
      const shortUrl = await shortenerService.createShortLink(url, title);
      
      res.json({
        success: true,
        originalUrl: url,
        shortUrl: shortUrl,
        title: title || ''
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ShortenerController();