#!/bin/sh
crontab -l > topupcron
#echo new cron into cron file
echo "*/5 * * * * /usr/local/bin/node /home/btcteam/lndhubnode/LndHub/scripts/topup_queuer.js" >> topupcron
#install new cron file
crontab topupcron
rm topupcron
