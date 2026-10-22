#!/bin/zsh
cd "${0:A:h}"
if [[ ! -f node_modules/electron/path.txt ]]; then
  print '桌面运行环境尚未安装完成，请先运行 npm install。'
  read '?按回车退出'
  exit 1
fi
npm start
