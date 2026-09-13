# 服务器 SSH 登录记录

更新时间：2026-08-31

## 服务器

- 主机别名：`fin-hub-server`
- IP：`8.138.19.56`
- 登录用户：`root`
- 系统：Ubuntu 26.04 LTS

## 本机 SSH 配置

本机已在 `~/.ssh/config` 中配置：

```sshconfig
Host fin-hub-server
    HostName 8.138.19.56
    User root
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

## 密钥

- 私钥路径：`~/.ssh/id_ed25519`
- 公钥路径：`~/.ssh/id_ed25519.pub`
- 公钥指纹：`SHA256:OENh/X3KuoJjpLyD89JaFrMlH5gP3fai5lc7heW9FyY`
- 公钥备注：`hongmudaren-server`

服务器已将本机公钥写入：

```bash
/root/.ssh/authorized_keys
```

服务器权限设置：

```bash
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
chown -R root:root /root/.ssh
```

## 登录方式

推荐使用别名登录：

```bash
ssh fin-hub-server
```

也可以显式指定密钥：

```bash
ssh -i ~/.ssh/id_ed25519 root@8.138.19.56
```

验证免密登录：

```bash
ssh -o BatchMode=yes fin-hub-server 'hostname && whoami'
```

预期返回：

```text
iZ7xvfosggxqhhkwmzdtqzZ
root
```

## 部署常用命令

复制文件到服务器：

```bash
scp -i ~/.ssh/id_ed25519 ./local-file root@8.138.19.56:/root/
```

使用别名复制文件：

```bash
scp ./local-file fin-hub-server:/root/
```

远程执行命令：

```bash
ssh fin-hub-server 'pwd && uptime'
```

同步目录：

```bash
rsync -avz --delete ./dist/ fin-hub-server:/opt/fin-hub/
```

## 安全说明

- 文档只记录密钥路径和公钥指纹，不记录私钥内容。
- 不建议继续依赖密码登录；完成部署后可以评估关闭 SSH 密码登录。
- 如果更换本机密钥，需要重新追加新的公钥到服务器 `/root/.ssh/authorized_keys`。
