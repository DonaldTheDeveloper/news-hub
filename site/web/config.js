// Where the site loads its news from. Replace DonaldTheDeveloper/news-hub with your GitHub user and repository name.
window.NEWSHUB = {
  dataUrl: "https://raw.githubusercontent.com/DonaldTheDeveloper/news-hub/data/news.json",   // refreshed every 30 minutes by the Action
  fallbackUrl: "/data/news.json",                                          // sample shipped with the site
};
