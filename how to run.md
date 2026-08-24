npm run dev:guide 

#服务器部署
systemctl status guide-server   # 查看状态
systemctl stop guide-server     # 停止服务
systemctl start guide-server    # 启动服务
systemctl restart guide-server  # 重启服务
journalctl -u guide-server -f   # 查看实时日志

systemctl daemon-reload && systemctl start guide-server && systemctl enable guide-server && systemctl status guide-server --no-pager -l